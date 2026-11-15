use crate::{
    model::{atomic_write, now, Entry, Novel},
    novelpia::Source,
};
use anyhow::{bail, Context, Result};
use chrono::{DateTime, SecondsFormat, TimeDelta, Utc};
use image::{
    codecs::{jpeg::JpegEncoder, png::PngEncoder},
    DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    ffi::OsStr,
    fs::{self, File},
    io::{BufRead, BufReader, Cursor, ErrorKind, Read, Seek},
    os::windows::fs::MetadataExt,
    path::{Component, Path, PathBuf},
};
use windows::{
    core::HSTRING,
    Win32::{
        Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT,
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
        UI::Shell::{
            BHID_Transfer, FOLDERID_RecycleBinFolder, IShellItem, ITransferSource,
            SHCreateItemFromParsingName, SHGetKnownFolderItem, KF_FLAG_DEFAULT, TSF_NORMAL,
        },
    },
};

const MAX_PIXELS: u64 = 40_000_000;

pub fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn decode(reader: impl BufRead + Seek) -> Result<DynamicImage> {
    let mut reader = ImageReader::new(reader).with_guessed_format()?;
    if !matches!(
        reader.format(),
        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Gif)
    ) {
        bail!("Ожидается изображение PNG, JPEG, WebP или GIF.");
    }
    let mut limits = Limits::default();
    limits.max_alloc = Some(200_000_000);
    limits.max_image_width = Some(MAX_PIXELS as u32);
    limits.max_image_height = Some(MAX_PIXELS as u32);
    reader.limits(limits);
    let mut decoder = reader.into_decoder()?;
    let (w, h) = decoder.dimensions();
    if u64::from(w) * u64::from(h) > MAX_PIXELS {
        bail!("Изображение превышает 40 миллионов пикселей.");
    }
    let orientation = decoder.orientation()?;
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    Ok(image)
}

pub fn preview(file: &Path) -> Result<Vec<u8>> {
    let image = decode(BufReader::new(File::open(file)?))?;
    let thumbnail = if image.width() > 560 || image.height() > 840 {
        image.resize(560, 840, image::imageops::FilterType::Triangle)
    } else {
        image
    };
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 85).encode_image(&thumbnail.into_rgb8())?;
    Ok(bytes)
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    novel_id: String,
    title: String,
    entries: Vec<Entry>,
}

pub struct Archive {
    directory: PathBuf,
    manifest: Manifest,
}

fn png_name(file: &Path, hash: &str) -> bool {
    valid_hash(hash)
        && file
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(&format!("_{hash}.png")))
}

pub fn known_file(entry: &Entry, novel: &Novel) -> bool {
    entry.file.is_absolute()
        && png_name(&entry.file, &entry.hash)
        && entry
            .file
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|folder| folder == novel.folder.as_str())
}

fn exists(file: &Path) -> bool {
    fs::symlink_metadata(file).is_ok_and(|m| m.file_type().is_file())
}

fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
}

fn checked_directory(directory: &Path, folder: &OsStr) -> Result<Option<PathBuf>> {
    if !directory.is_absolute()
        || directory
            .components()
            .any(|part| part == Component::ParentDir)
    {
        bail!("Недопустимый путь к папке архива.");
    }
    let ancestors: Vec<_> = directory.ancestors().collect();
    for path in ancestors.into_iter().rev() {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        if !metadata.is_dir() || is_reparse_point(&metadata) {
            bail!(
                "Путь архива содержит ссылку или не является папкой: {}",
                path.display()
            );
        }
    }
    let canonical = directory.canonicalize()?;
    if canonical
        .file_name()
        .is_none_or(|name| !name.eq_ignore_ascii_case(folder))
    {
        bail!("Имя папки архива не совпадает с именем в настройках.");
    }
    Ok(Some(canonical))
}

fn verify_archive(directory: &Path, novel: &Novel, history: Vec<&Entry>) -> Result<bool> {
    let mut covers: HashSet<_> = history
        .into_iter()
        .filter_map(|entry| Some((entry.file.file_name()?.to_owned(), entry.bytes)))
        .collect();
    let mut files = Vec::new();
    let mut has_manifest = false;
    for file in fs::read_dir(directory)? {
        let file = file?;
        let path = file.path();
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_file() || is_reparse_point(&metadata) {
            bail!(
                "В папке архива найден посторонний объект: {}",
                path.display()
            );
        }
        let name = file.file_name();
        if name.eq_ignore_ascii_case("archive.json") {
            let manifest: Manifest = serde_json::from_slice(&fs::read(&path)?)
                .context("Не удалось прочитать список сохранённых обложек")?;
            if manifest.version != 1 || manifest.novel_id != novel.id {
                bail!("Список обложек не соответствует архиву новеллы.");
            }
            // The user may have moved an archive. In its manifest the file names
            // still identify its covers, even if their original root has changed.
            covers.extend(
                manifest
                    .entries
                    .iter()
                    .filter(|entry| known_file(entry, novel))
                    .filter_map(|entry| Some((entry.file.file_name()?.to_owned(), entry.bytes))),
            );
            has_manifest = true;
        } else {
            files.push((name, metadata.len()));
        }
    }
    if !has_manifest && files.is_empty() {
        return Ok(false);
    }
    for file in files {
        if !covers.contains(&file) {
            bail!(
                "Файл не совпадает с сохранённой обложкой: {}",
                file.0.to_string_lossy()
            );
        }
    }
    Ok(true)
}

fn folders_to_recycle(novel: &Novel, root: &Path) -> Result<Vec<PathBuf>> {
    if novel.folder.is_empty() {
        return Ok(Vec::new());
    }
    let folder = OsStr::new(&novel.folder);
    let suffix = format!(" [{}]", novel.id);
    if novel.id.is_empty()
        || !novel.id.bytes().all(|b| b.is_ascii_digit())
        || novel.folder.len() <= suffix.len()
        || !novel.folder.ends_with(&suffix)
        || novel
            .folder
            .contains(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
        || novel.folder.chars().any(|c| c.is_ascii_control())
    {
        bail!("Недопустимое имя папки архива.");
    }

    let mut candidates: BTreeMap<PathBuf, Vec<&Entry>> = BTreeMap::new();
    if !root.as_os_str().is_empty() {
        candidates.entry(root.join(folder)).or_default();
    }
    for entry in novel
        .history
        .iter()
        .filter(|entry| known_file(entry, novel))
    {
        if let Some(parent) = entry.file.parent() {
            candidates.entry(parent.to_owned()).or_default().push(entry);
        }
    }

    let mut directories = BTreeMap::new();
    for (directory, entries) in candidates {
        if let Some(canonical) = checked_directory(&directory, folder)
            .with_context(|| format!("Не удалось проверить папку {}", directory.display()))?
        {
            let (_, history) = directories
                .entry(canonical)
                .or_insert_with(|| (directory, Vec::new()));
            history.extend(entries);
        }
    }
    let mut verified = Vec::new();
    for (directory, history) in directories.into_values() {
        if verify_archive(&directory, novel, history)
            .with_context(|| format!("Не удалось проверить папку {}", directory.display()))?
        {
            verified.push(directory);
        }
    }
    Ok(verified)
}

pub fn recycle_folders(novel: &Novel, root: &Path) -> Result<()> {
    let directories = folders_to_recycle(novel, root)?;
    if directories.is_empty() {
        return Ok(());
    }
    // Shell file operations require an STA. Use a dedicated thread so this works
    // independently of the calling thread's COM apartment.
    std::thread::Builder::new()
        .spawn(move || recycle_directories(&directories))?
        .join()
        .map_err(|_| anyhow::anyhow!("Сбой при перемещении папок архива в корзину."))?
        .context("Не удалось переместить папки архива в корзину Windows")
}

fn recycle_directories(directories: &[PathBuf]) -> Result<()> {
    struct Com;
    impl Drop for Com {
        fn drop(&mut self) {
            // Balances the successful CoInitializeEx on this thread.
            unsafe { CoUninitialize() };
        }
    }

    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        let _com = Com;
        let bin: IShellItem =
            SHGetKnownFolderItem(&FOLDERID_RecycleBinFolder, KF_FLAG_DEFAULT, None)?;
        let mut sources = Vec::with_capacity(directories.len());
        for directory in directories {
            let path = HSTRING::from(directory.as_os_str());
            let item: IShellItem = SHCreateItemFromParsingName(&path, None)
                .with_context(|| format!("Не удалось открыть папку {}", directory.display()))?;
            let transfer: ITransferSource =
                item.GetParent()?.BindToHandler(None, &BHID_Transfer)?;
            sources.push((directory, item, transfer));
        }
        // RecycleItem requires a recycle location and returns the recycled item.
        // Keep this independent of the Shell's general-purpose delete operation.
        for (index, (directory, item, transfer)) in sources.into_iter().enumerate() {
            let recycled = transfer.RecycleItem(&item, &bin, TSF_NORMAL.0 as u32);
            let moved = index + usize::from(recycled.is_ok());
            recycled
                .map_err(anyhow::Error::from)
                .and_then(|_| match fs::symlink_metadata(directory) {
                    Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
                    Err(e) => Err(e.into()),
                    Ok(_) => bail!("Папка осталась на диске."),
                })
                .with_context(|| {
                    format!(
                        "Не удалось завершить операцию с папкой {}. В корзину перемещено {} из {}.",
                        directory.display(),
                        moved,
                        directories.len()
                    )
                })?;
        }
    }
    Ok(())
}

fn content_address(source: &str) -> Option<(String, usize)> {
    let url = url::Url::parse(source).ok()?;
    crate::novelpia::validate_image_url(&url).ok()?;
    let name = url.path().rsplit('/').next()?;
    let (md5, length) = name.split_once('_')?;
    if md5.len() != 32
        || !md5
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let length = length
        .strip_suffix("_q_ori.file")
        .or_else(|| length.strip_suffix("_ori.file"))?;
    Some((md5.to_owned(), length.parse().ok()?))
}

fn intact_png(entry: &Entry) -> bool {
    if !fs::symlink_metadata(&entry.file).is_ok_and(|metadata| {
        metadata.is_file() && !is_reparse_point(&metadata) && metadata.len() == entry.bytes
    }) {
        return false;
    }
    let Ok(file) = File::open(&entry.file) else {
        return false;
    };
    let mut reader = BufReader::new(file);
    reader
        .fill_buf()
        .is_ok_and(|header| header.starts_with(b"\x89PNG\r\n\x1a\n"))
        && decode(reader)
            .is_ok_and(|image| image.width() == entry.width && image.height() == entry.height)
}

pub fn cached_cover(novel: &Novel, source: &Source) -> Option<Entry> {
    content_address(&source.url)?;
    let (entry, at) = if let Some(verification) = novel.cover_verifications.get(&source.url) {
        let verification = verification.as_ref()?;
        let entry = novel
            .history
            .iter()
            .rev()
            .find(|entry| entry.hash == verification.hash)?;
        (entry, &verification.at)
    } else if novel.cover_verifications.is_empty()
        && novel.sources.iter().any(|old| old.url == source.url)
    {
        // A 2.1.0 profile has no per-URL proof. The original can seed it only
        // from the preferred cover, even if pixel dedup moved its archive entry.
        let entry = novel
            .history
            .iter()
            .rev()
            .find(|entry| entry.source == source.url)?;
        if entry.addressed_source != Some(true)
            || (source.kind == "original" && novel.latest_hash.as_ref() != Some(&entry.hash))
        {
            return None;
        }
        let at = if let Some(at) = &entry.source_validated_at {
            at
        } else {
            let at = novel.last_check.as_ref()?;
            if novel.failures != 0
                || !novel.error.is_empty()
                || DateTime::parse_from_rfc3339(at).ok()?
                    < DateTime::parse_from_rfc3339(&entry.saved_at).ok()?
            {
                return None;
            }
            at
        };
        (entry, at)
    } else {
        return None;
    };
    let age = Utc::now().signed_duration_since(DateTime::parse_from_rfc3339(at).ok()?);
    if age < TimeDelta::zero()
        || age > TimeDelta::hours(24)
        || !known_file(entry, novel)
        || !intact_png(entry)
    {
        return None;
    }
    let mut entry = entry.clone();
    entry.source_validated_at = Some(at.clone());
    Some(entry)
}

impl Archive {
    pub fn open(novel: &Novel, root: &Path) -> Result<Self> {
        let folder = Path::new(&novel.folder);
        if !matches!(folder.components().next(), Some(Component::Normal(_)))
            || folder.components().count() != 1
        {
            bail!("Недопустимое имя папки архива.");
        }
        let directory = root.join(folder);
        fs::create_dir_all(&directory)?;
        if fs::canonicalize(&directory)?.parent() != Some(fs::canonicalize(root)?.as_path()) {
            bail!("Папка архива ссылается за пределы выбранной папки.");
        }
        let manifest_path = directory.join("archive.json");
        let mut manifest: Manifest = match fs::read(&manifest_path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Manifest::default(),
            Err(e) => return Err(e.into()),
        };
        if manifest.novel_id != novel.id {
            manifest = Manifest::default();
        }
        manifest.version = 1;
        manifest.novel_id = novel.id.clone();
        manifest.title = novel.title.clone();
        manifest.entries.retain(|entry| {
            entry.file.parent() == Some(directory.as_path()) && png_name(&entry.file, &entry.hash)
        });
        let mut hashes: HashSet<_> = manifest
            .entries
            .iter()
            .map(|entry| entry.hash.clone())
            .collect();
        for file in fs::read_dir(&directory)? {
            let file = file?;
            if !file.file_type()?.is_file() {
                continue;
            }
            let file_path = file.path();
            let Some(name) = file_path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let Some((_, hash)) = name.rsplit_once('_') else {
                continue;
            };
            if hashes.contains(hash) || !png_name(&file_path, hash) {
                continue;
            }
            let mut header = [0_u8; 24];
            if File::open(&file_path)?.read_exact(&mut header).is_err()
                || &header[..8] != b"\x89PNG\r\n\x1a\n"
            {
                continue;
            }
            let metadata = file.metadata()?;
            let saved_at = DateTime::<Utc>::from(metadata.modified()?)
                .to_rfc3339_opts(SecondsFormat::Millis, true);
            let hash = hash.to_owned();
            hashes.insert(hash.clone());
            manifest.entries.push(Entry {
                hash,
                file: file_path,
                saved_at,
                width: u32::from_be_bytes(header[16..20].try_into()?),
                height: u32::from_be_bytes(header[20..24].try_into()?),
                bytes: metadata.len(),
                kind: "recovered".into(),
                source: String::new(),
                addressed_source: None,
                source_validated_at: None,
            });
        }
        Ok(Self {
            directory,
            manifest,
        })
    }

    pub fn recovered(&self) -> impl Iterator<Item = &Entry> {
        self.manifest
            .entries
            .iter()
            .filter(|entry| exists(&entry.file))
    }

    pub fn save(&mut self, novel: &Novel, source: &Source, bytes: &[u8]) -> Result<(Entry, bool)> {
        let address = content_address(&source.url);
        let validated_address = address.as_ref().filter(|(hash, size)| {
            *size == bytes.len() && *hash == format!("{:x}", md5::compute(bytes))
        });
        let validated_at = validated_address.map(|_| now());
        // Original/thumbnail URLs may be aliases of the same immutable source.
        // Validate the downloaded bytes before using the address, so a server
        // replacing a file at the same URL still goes through pixel comparison.
        let addressed_entry = if let Some(address) = validated_address {
            let candidates = novel
                .history
                .iter()
                .filter(|entry| {
                    entry.addressed_source != Some(false)
                        && content_address(&entry.source).as_ref() == Some(address)
                        && known_file(entry, novel)
                })
                .collect::<Vec<_>>();
            let known = candidates
                .iter()
                .find(|entry| entry.addressed_source == Some(true))
                .copied()
                .or_else(|| (candidates.len() == 1).then(|| candidates[0]));
            if let Some(entry) = known.filter(|entry| intact_png(entry)) {
                let mut entry = entry.clone();
                entry.addressed_source = Some(true);
                entry.source_validated_at = validated_at;
                entry.source.clone_from(&source.url);
                entry.kind.clone_from(&source.kind);
                return Ok((entry, false));
            }
            known
        } else {
            None
        };
        let image = decode(Cursor::new(bytes))?.into_rgba8();
        let (width, height) = image.dimensions();
        let hash = addressed_entry
            .map(|entry| entry.hash.clone())
            .unwrap_or_else(|| {
                let mut digest = Sha256::new();
                digest.update(format!("{width}x{height}:"));
                digest.update(image.as_raw());
                format!("{:x}", digest.finalize())
            });
        let previous = addressed_entry.or_else(|| {
            novel
                .history
                .iter()
                .find(|e| e.hash == hash && known_file(e, novel))
        });
        if let Some(entry) = previous.filter(|e| addressed_entry.is_none() && intact_png(e)) {
            let mut entry = entry.clone();
            if address.is_some() {
                entry.addressed_source = Some(validated_address.is_some());
                entry.source_validated_at = validated_at;
                entry.source.clone_from(&source.url);
                entry.kind.clone_from(&source.kind);
            }
            return Ok((entry, false));
        }
        let manifest_entry = self
            .manifest
            .entries
            .iter()
            .find(|entry| entry.hash == hash);
        let destination = previous
            .filter(|entry| entry.file.parent() == Some(self.directory.as_path()))
            .or(manifest_entry);
        let saved_at = previous
            .or(manifest_entry)
            .map(|entry| entry.saved_at.clone())
            .filter(|d| DateTime::parse_from_rfc3339(d).is_ok())
            .unwrap_or_else(now);
        let file = destination
            .map(|entry| entry.file.clone())
            .unwrap_or_else(|| {
                self.directory
                    .join(format!("{}_{hash}.png", saved_at.replace([':', '.'], "-")))
            });
        let saved = destination.is_none_or(|entry| !intact_png(entry));
        if saved {
            let mut png = Vec::new();
            PngEncoder::new(&mut png).write_image(
                image.as_raw(),
                width,
                height,
                image::ExtendedColorType::Rgba8,
            )?;
            atomic_write(&file, &png).context("Не удалось сохранить PNG")?;
        }
        let entry = Entry {
            hash,
            bytes: fs::metadata(&file)?.len(),
            file,
            saved_at,
            width,
            height,
            kind: source.kind.clone(),
            source: source.url.clone(),
            addressed_source: Some(validated_address.is_some()),
            source_validated_at: validated_at,
        };
        self.remember(&entry)?;
        Ok((entry, saved))
    }

    fn remember(&mut self, entry: &Entry) -> Result<()> {
        if entry.file.parent() != Some(self.directory.as_path()) {
            return Ok(());
        }
        self.manifest.entries.retain(|old| old.hash != entry.hash);
        self.manifest.entries.push(entry.clone());
        atomic_write(
            &self.directory.join("archive.json"),
            &serde_json::to_vec_pretty(&self.manifest)?,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved_cover(novel: &Novel, root: &Path) -> Entry {
        let source = Source {
            kind: "original".into(),
            url: "https://images.novelpia.com/imagebox/cover/a.file".into(),
        };
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(&[7, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();
        Archive::open(novel, root)
            .unwrap()
            .save(novel, &source, &png)
            .unwrap()
            .0
    }

    fn tracked_book() -> Novel {
        Novel {
            id: "1".into(),
            title: "Book".into(),
            folder: "Book [1]".into(),
            ..Default::default()
        }
    }

    fn png(color: u8) -> Vec<u8> {
        let mut bytes = Vec::new();
        PngEncoder::new(&mut bytes)
            .write_image(&[color, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();
        bytes
    }

    fn addressed_cover() -> (tempfile::TempDir, Novel, Source, Vec<u8>) {
        let temp = tempfile::tempdir().unwrap();
        let mut novel = tracked_book();
        let bytes = png(8);
        let source = Source {
            kind: "original".into(),
            url: format!(
                "https://images.novelpia.com/imagebox/cover/{:x}_{}_q_ori.file",
                md5::compute(&bytes),
                bytes.len()
            ),
        };
        let (entry, _) = Archive::open(&novel, temp.path())
            .unwrap()
            .save(&novel, &source, &bytes)
            .unwrap();
        novel.history.push(entry);
        novel.latest_hash = Some(novel.history[0].hash.clone());
        novel.sources.push(source.clone());
        (temp, novel, source, bytes)
    }

    #[test]
    fn reuses_recently_validated_png_without_a_successful_page_check() {
        let (_temp, novel, source, _) = addressed_cover();

        let cached = cached_cover(&novel, &source).expect("expected a verified cover");
        assert_eq!(cached.file, novel.history[0].file);
    }

    #[test]
    fn seeds_legacy_validation_from_a_successful_check_once() {
        let (_temp, mut novel, source, _) = addressed_cover();
        let old_check = (Utc::now() - chrono::TimeDelta::hours(1)).to_rfc3339();
        let mut legacy = serde_json::to_value(&novel.history[0]).unwrap();
        legacy.as_object_mut().unwrap().remove("sourceValidatedAt");
        legacy["savedAt"] = serde_json::json!("2026-10-01T00:00:00Z");
        novel.history[0] = serde_json::from_value(legacy).unwrap();
        novel.last_check = Some(old_check.clone());
        novel.failures = 1;
        assert!(cached_cover(&novel, &source).is_none());
        novel.failures = 0;

        novel.history[0] = cached_cover(&novel, &source).expect("expected a migrated cover");
        novel.last_check = Some(now());
        let cached = cached_cover(&novel, &source).expect("expected a verified cover");
        assert_eq!(
            serde_json::to_value(cached).unwrap()["sourceValidatedAt"],
            old_check
        );
    }

    #[test]
    fn expires_validation_even_after_a_successful_page_check() {
        let (_temp, mut novel, source, _) = addressed_cover();
        let mut stale = serde_json::to_value(&novel.history[0]).unwrap();
        stale["sourceValidatedAt"] =
            serde_json::json!((Utc::now() - chrono::TimeDelta::hours(25)).to_rfc3339());
        novel.history[0] = serde_json::from_value(stale).unwrap();
        novel.last_check = Some(now());

        assert!(cached_cover(&novel, &source).is_none());
    }

    #[test]
    fn rejects_missing_or_damaged_verified_png() {
        let (_temp, novel, source, _) = addressed_cover();
        let path = &novel.history[0].file;
        let mut bytes = fs::read(path).unwrap();
        let compressed_data = bytes.windows(4).position(|chunk| chunk == b"IDAT").unwrap() + 4;
        bytes[compressed_data] ^= 0x80;
        fs::write(path, bytes).unwrap();
        assert!(cached_cover(&novel, &source).is_none());
        fs::remove_file(path).unwrap();
        assert!(cached_cover(&novel, &source).is_none());
    }

    #[test]
    fn rejects_an_old_verified_entry_after_a_replacement_at_the_same_url() {
        let (temp, mut novel, source, _) = addressed_cover();
        let older = saved_cover(&novel, temp.path());
        novel.history.insert(0, older);
        let (replacement, _) = Archive::open(&novel, temp.path())
            .unwrap()
            .save(&novel, &source, &png(7))
            .unwrap();
        let dynamic = Source {
            url: novel.history[0].source.clone(),
            ..source.clone()
        };
        novel.history.retain(|entry| entry.hash != replacement.hash);
        novel.history.push(replacement);

        assert_eq!(novel.history[1].source, source.url);
        assert!(cached_cover(&novel, &source).is_none());
        assert!(cached_cover(&novel, &dynamic).is_none());
    }

    #[test]
    fn finds_current_manifest_and_older_directory_from_history() {
        let temp = tempfile::tempdir().unwrap();
        let previous = temp.path().join("previous");
        let current = temp.path().join("current");
        let mut novel = tracked_book();
        let older_entry = saved_cover(&novel, &previous);
        let current_entry = saved_cover(&novel, &current);
        let older_folder = older_entry.file.parent().unwrap().to_owned();
        let current_folder = current_entry.file.parent().unwrap().to_owned();
        fs::remove_file(older_folder.join("archive.json")).unwrap();
        novel.history.push(older_entry);

        let found: HashSet<_> = folders_to_recycle(&novel, &current)
            .unwrap()
            .into_iter()
            .collect();
        assert_eq!(found, HashSet::from([older_folder, current_folder]));
    }

    #[test]
    fn ignores_missing_directory_without_creating_it() {
        let temp = tempfile::tempdir().unwrap();
        let novel = tracked_book();

        assert!(folders_to_recycle(&novel, temp.path()).unwrap().is_empty());
        assert!(!temp.path().join(&novel.folder).exists());
    }

    #[test]
    fn skips_empty_current_directory_when_older_archive_exists() {
        let temp = tempfile::tempdir().unwrap();
        let previous = temp.path().join("previous");
        let current = temp.path().join("current");
        let mut novel = tracked_book();
        let entry = saved_cover(&novel, &previous);
        let older_folder = entry.file.parent().unwrap().to_owned();
        novel.history.push(entry);
        let empty = current.join(&novel.folder);
        fs::create_dir_all(&empty).unwrap();

        assert_eq!(
            folders_to_recycle(&novel, &current).unwrap(),
            [older_folder]
        );
        assert!(empty.is_dir());
    }

    #[test]
    fn rejects_mixed_folder_with_unlisted_png() {
        let temp = tempfile::tempdir().unwrap();
        let novel = tracked_book();
        let entry = saved_cover(&novel, temp.path());
        let unlisted = entry
            .file
            .with_file_name(format!("My cover_{}.png", entry.hash));
        fs::copy(&entry.file, &unlisted).unwrap();

        assert!(folders_to_recycle(&novel, temp.path()).is_err());
        assert!(unlisted.is_file());
    }

    #[test]
    fn rejects_manifest_for_different_novel() {
        let temp = tempfile::tempdir().unwrap();
        let novel = tracked_book();
        let entry = saved_cover(&novel, temp.path());
        let path = entry.file.with_file_name("archive.json");
        let mut manifest: Manifest = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        manifest.novel_id = "2".into();
        fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();

        assert!(folders_to_recycle(&novel, temp.path()).is_err());
    }

    #[test]
    fn rejects_folder_path_with_parent_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let novel = Novel {
            folder: "../Book [1]".into(),
            ..tracked_book()
        };

        assert!(folders_to_recycle(&novel, temp.path()).is_err());
    }

    #[test]
    fn rejects_directory_junction_in_archive_path() {
        let temp = tempfile::tempdir().unwrap();
        let real_root = temp.path().join("real");
        let junction = temp.path().join("junction");
        let novel = tracked_book();
        let entry = saved_cover(&novel, &real_root);
        let result = std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/j"])
            .arg(&junction)
            .arg(&real_root)
            .output()
            .unwrap();
        assert!(result.status.success(), "{:?}", result);

        let result = folders_to_recycle(&novel, &junction);
        fs::remove_dir(&junction).unwrap();
        assert!(result.is_err());
        assert!(entry.file.is_file());
    }

    #[test]
    fn keeps_legacy_png_for_verified_source_alias_but_detects_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let mut novel = Novel {
            id: "1".into(),
            title: "Book".into(),
            folder: "Book [1]".into(),
            ..Default::default()
        };
        let encode = |color| {
            let mut bytes = Vec::new();
            PngEncoder::new(&mut bytes)
                .write_image(&[color, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
                .unwrap();
            bytes
        };
        let bytes = encode(8);
        let address = format!("{:x}_{}", md5::compute(&bytes), bytes.len());
        let url = format!("https://images.novelpia.com/imagebox/cover/{address}");
        let original = Source {
            kind: "original".into(),
            url: format!("{url}_q_ori.file"),
        };
        let cover = Source {
            kind: "cover".into(),
            url: format!("{url}_ori.file"),
        };
        let mut archive = Archive::open(&novel, temp.path()).unwrap();
        // Simulate a profile saved by the previous decoder, whose pixels differ.
        let (mut legacy, _) = archive.save(&novel, &original, &encode(7)).unwrap();
        legacy.addressed_source = None;
        novel.history.push(legacy.clone());
        let (entry, saved) = archive.save(&novel, &cover, &bytes).unwrap();
        assert!(!saved);
        assert_eq!(entry.hash, legacy.hash);
        assert_eq!(entry.addressed_source, Some(true));
        fs::remove_file(&legacy.file).unwrap();
        let (restored, saved) = archive.save(&novel, &cover, &bytes).unwrap();
        assert!(saved);
        assert_eq!(restored.hash, legacy.hash);
        assert_eq!(restored.file, legacy.file);
        assert_eq!(restored.saved_at, legacy.saved_at);
        let (replacement, saved) = archive.save(&novel, &cover, &encode(9)).unwrap();
        assert!(saved);
        assert_ne!(replacement.hash, legacy.hash);
        assert_eq!(replacement.addressed_source, Some(false));
    }

    #[test]
    fn preserves_legacy_pixel_hash_and_restores_missing_png() {
        let temp = tempfile::tempdir().unwrap();
        let mut novel = Novel {
            id: "1".into(),
            title: "Book".into(),
            folder: "Book [1]".into(),
            ..Default::default()
        };
        let source = Source {
            kind: "original".into(),
            url: "https://images.novelpia.com/imagebox/cover/a.file".into(),
        };
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(&[7, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();
        let mut archive = Archive::open(&novel, temp.path()).unwrap();
        let (entry, fresh) = archive.save(&novel, &source, &png).unwrap();
        assert!(fresh);
        assert_eq!(
            entry.hash,
            format!("{:x}", Sha256::digest(b"1x1:\x07\0\0\xff"))
        );
        novel.history.push(entry.clone());
        assert!(!archive.save(&novel, &source, &png).unwrap().1);
        fs::remove_file(&entry.file).unwrap();
        let (restored, fresh) = archive.save(&novel, &source, &png).unwrap();
        assert!(fresh);
        assert_eq!(restored.file, entry.file);
        assert_eq!(restored.saved_at, entry.saved_at);
        assert_eq!(preview(&entry.file).unwrap()[..2], [0xff, 0xd8]);
    }
}
