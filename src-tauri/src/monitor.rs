use crate::{
    archive::{self, Archive},
    model::{
        atomic_write, label, now, Activity, Cover, Novel, Policy, Profile, Store, Transition,
        STATUSES,
    },
    novelpia::{inspect_page, parse_novel_url, safe_folder, Client, FetchError},
};
use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

pub struct Notice {
    pub id: Option<String>,
    pub title: String,
    pub body: String,
    pub silent: bool,
}

pub struct Monitor {
    store: Mutex<Store>,
    client: Client,
    operation: Mutex<()>,
    preview_gate: Mutex<()>,
    busy: Mutex<Option<String>>,
    notices: Mutex<Vec<Notice>>,
    callback: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl Monitor {
    pub fn open(profile: PathBuf) -> Result<Self> {
        let store = Store::open(profile)?;
        fs::create_dir_all(store.directory.join("previews"))?;
        Ok(Self {
            store: Mutex::new(store),
            client: Client::new()?,
            operation: Mutex::new(()),
            preview_gate: Mutex::new(()),
            busy: Mutex::new(None),
            notices: Mutex::new(Vec::new()),
            callback: Mutex::new(None),
        })
    }

    pub fn set_changed(&self, callback: impl Fn() + Send + Sync + 'static) {
        *self.callback.lock().unwrap() = Some(Arc::new(callback));
    }

    fn changed(&self) {
        let callback = self.callback.lock().unwrap().clone();
        if let Some(callback) = callback {
            callback();
        }
    }

    pub fn wait_for_idle(&self) {
        drop(self.operation.lock().unwrap());
    }

    pub fn drain_notices(&self) -> Vec<Notice> {
        std::mem::take(&mut *self.notices.lock().unwrap())
    }

    pub fn snapshot(&self) -> Value {
        let store = self.store.lock().unwrap();
        let mut state = serde_json::to_value(&store.profile).expect("profile JSON");
        state["busy"] = json!(self.busy.lock().unwrap().iter().collect::<Vec<_>>());
        state["recovered"] = json!(store.recovered);
        state["statusLabels"] =
            json!(
                ["completed", "discontinued", "delayed", "ongoing", "unknown"]
                    .map(|status| (status, label(status)))
                    .into_iter()
                    .collect::<std::collections::BTreeMap<_, _>>()
            );
        state["appVersion"] = json!(env!("CARGO_PKG_VERSION"));
        state["canLogin"] = json!(true);
        state["notificationWarning"] = json!("");
        state
    }

    fn update(&self, change: impl FnOnce(&mut Profile) -> Result<()>) -> Result<()> {
        self.store.lock().unwrap().update(change)
    }

    fn active_ids(&self) -> Vec<String> {
        self.store
            .lock()
            .unwrap()
            .profile
            .novels
            .iter()
            .map(|n| n.id.clone())
            .collect()
    }

    pub fn action(&self, action: &str, payload: Value) -> Result<Value> {
        if action == "snapshot" {
            return Ok(self.snapshot());
        }
        if action == "check" {
            let ids = if payload.is_null() {
                self.active_ids()
            } else {
                vec![string(&payload)?.to_owned()]
            };
            for id in ids {
                let _job = self.operation.lock().unwrap();
                self.check(&id, false, !payload.is_null())?;
            }
            return Ok(self.snapshot());
        }
        let _job = self.operation.lock().unwrap();
        match action {
            "add" => {
                let (id, url) = parse_novel_url(string(&payload)?)?;
                self.update(|s| {
                    if s.root.as_os_str().is_empty() {
                        bail!("Сначала выберите папку архива.");
                    }
                    if s.novels.iter().any(|n| n.id == id) {
                        bail!("Эта новелла уже добавлена.");
                    }
                    let old = s.retired.remove(&id);
                    let resumed = old.is_some();
                    let mut novel = old.unwrap_or_else(|| Novel {
                        id: id.clone(),
                        url,
                        title: format!("Novelpia {id}"),
                        ..Default::default()
                    });
                    novel.note_change(&now());
                    let mut event = Activity::new(&novel, "watch_added", now());
                    event.resumed = resumed;
                    s.novels.push(novel);
                    s.append(vec![event]);
                    Ok(())
                })?;
                self.changed();
                self.check(&id, true, true)?;
                return Ok(self.snapshot());
            }
            "remove" => {
                let id = string(&payload)?;
                self.update(|s| {
                    let index = s
                        .novels
                        .iter()
                        .position(|n| n.id == id)
                        .context("Новелла не найдена.")?;
                    let novel = s.novels.remove(index);
                    s.append(vec![Activity::new(&novel, "watch_removed", now())]);
                    s.retired.insert(novel.id.clone(), novel);
                    Ok(())
                })?;
            }
            "settings" => self.update(|s| update_settings(s, payload))?,
            "novel-notifications" => {
                let id = string(&payload["id"])?;
                let policy: Option<Policy> = serde_json::from_value(
                    payload
                        .get("policy")
                        .context("Не указаны настройки уведомлений")?
                        .clone(),
                )?;
                if let Some(policy) = &policy {
                    policy.validate()?;
                }
                self.update(|s| {
                    s.novels
                        .iter_mut()
                        .find(|n| n.id == id)
                        .context("Новелла не найдена.")?
                        .status_notifications = policy;
                    Ok(())
                })?;
            }
            "activity-read" => {
                let sequence = payload.as_u64().context("Неверная отметка прочтения.")?;
                {
                    let store = self.store.lock().unwrap();
                    if sequence > store.profile.activity_sequence {
                        bail!("Неверная отметка прочтения.");
                    }
                    if sequence <= store.profile.activity_read_sequence {
                        drop(store);
                        return Ok(self.snapshot());
                    }
                }
                self.update(|s| {
                    s.activity_read_sequence = sequence;
                    Ok(())
                })?;
            }
            _ => bail!("Неизвестное действие."),
        }
        self.changed();
        Ok(self.snapshot())
    }

    pub fn tick(&self) -> Result<()> {
        for id in self.active_ids() {
            let Ok(_job) = self.operation.try_lock() else {
                return Ok(());
            };
            let due = {
                let store = self.store.lock().unwrap();
                let profile = &store.profile;
                !profile.paused
                    && !profile.root.as_os_str().is_empty()
                    && profile
                        .novels
                        .iter()
                        .any(|n| n.id == id && n.next_check <= Utc::now().timestamp_millis())
            };
            if due {
                self.check(&id, false, false)?;
            }
        }
        Ok(())
    }

    fn check(&self, id: &str, adding: bool, required: bool) -> Result<()> {
        let (novel, root, interval) = {
            let store = self.store.lock().unwrap();
            let s = &store.profile;
            let Some(novel) = s.novels.iter().find(|n| n.id == id) else {
                if required {
                    bail!("Новелла не найдена.");
                }
                return Ok(());
            };
            if s.root.as_os_str().is_empty() {
                bail!("Выберите папку архива.");
            }
            (novel.clone(), s.root.clone(), s.interval)
        };
        *self.busy.lock().unwrap() = Some(id.to_owned());
        self.changed();
        let result = self.perform_check(novel, &root, interval, adding, |url, image| {
            self.client.fetch(url, image)
        });
        *self.busy.lock().unwrap() = None;
        self.changed();
        result
    }

    fn perform_check(
        &self,
        mut novel: Novel,
        root: &std::path::Path,
        interval: u32,
        adding: bool,
        fetch: impl Fn(&str, bool) -> std::result::Result<Vec<u8>, FetchError>,
    ) -> Result<()> {
        let mut errors = Vec::new();
        let mut retry = 0;
        let mut events = Vec::new();
        let mut transition = None;
        let mut fresh = Vec::new();
        let mut restored = Vec::new();
        let initial = novel.history.is_empty();
        let known: HashSet<_> = novel.history.iter().map(|e| e.hash.clone()).collect();
        match fetch(&novel.url, false) {
            Err(error) => {
                retry = error.retry_after_ms;
                errors.push(error.to_string());
            }
            Ok(page) => {
                let data = inspect_page(&String::from_utf8_lossy(&page));
                if let Some(title) = data.title.filter(|title| !title.is_empty()) {
                    let old = std::mem::replace(&mut novel.title, title);
                    if old != novel.title
                        && !old.is_empty()
                        && old != format!("Novelpia {}", novel.id)
                    {
                        let mut event = Activity::new(&novel, "title_renamed", now());
                        event.from = Some(old);
                        event.to = Some(novel.title.clone());
                        novel.note_change(&event.at);
                        events.push(event);
                    }
                }
                transition = observe(&mut novel, data.status, data.status_reason);
                if let Some(change) = &transition {
                    let mut event = Activity::new(&novel, "status_changed", change.at.clone());
                    event.from = Some(change.from.clone());
                    event.to = Some(change.to.clone());
                    novel.note_change(&event.at);
                    events.push(event);
                }
                if data.sources.is_empty() {
                    errors.push("Обложка не найдена. Страница может требовать входа или её разметка изменилась.".into());
                } else {
                    if novel.folder.is_empty() {
                        novel.folder = safe_folder(&novel.title, &novel.id);
                        // A recoverable PNG must have a stable folder even if the final write fails.
                        self.update(|s| {
                            let target = s
                                .novels
                                .iter_mut()
                                .find(|n| n.id == novel.id)
                                .context("Новелла не найдена.")?;
                            target.folder.clone_from(&novel.folder);
                            Ok(())
                        })?;
                    }
                    novel.sources = data.sources;
                    match Archive::open(&novel, root) {
                        Err(error) => errors.push(error.to_string()),
                        Ok(mut archive) => {
                            let mut discovered = known.clone();
                            for entry in archive.recovered() {
                                if discovered.insert(entry.hash.clone()) {
                                    let mut event = Activity::new(
                                        &novel,
                                        "cover_saved",
                                        entry.saved_at.clone(),
                                    );
                                    event.imported = true;
                                    event.covers.push(Cover::from(entry));
                                    novel.note_change(&event.at);
                                    events.push(event);
                                    novel.history.push(entry.clone());
                                }
                            }
                            let mut latest = None;
                            for source in novel.sources.clone() {
                                let image = match fetch(&source.url, true) {
                                    Ok(bytes) => bytes,
                                    Err(error) => {
                                        retry = retry.max(error.retry_after_ms);
                                        errors.push(format!(
                                            "{}: {error}",
                                            source_label(&source.kind)
                                        ));
                                        continue;
                                    }
                                };
                                match archive.save(&novel, &source, &image) {
                                    Ok((entry, saved)) => {
                                        if latest.is_none() {
                                            latest = Some(entry.hash.clone());
                                        }
                                        if saved {
                                            if known.contains(&entry.hash) {
                                                restored.push(Cover::from(&entry));
                                            } else if discovered.insert(entry.hash.clone()) {
                                                fresh.push(Cover::from(&entry));
                                            }
                                        }
                                        novel.history.retain(|e| e.hash != entry.hash);
                                        novel.history.push(entry);
                                    }
                                    Err(error) => errors
                                        .push(format!("{}: {error}", source_label(&source.kind))),
                                }
                            }
                            if latest.is_some() {
                                novel.latest_hash = latest;
                            }
                        }
                    }
                }
            }
        }
        let at = now();
        let new_count = fresh.len();
        novel.last_saved = new_count + restored.len();
        if new_count != 0 {
            let mut event = Activity::new(&novel, "cover_saved", at.clone());
            event.initial = initial;
            event.covers = fresh;
            novel.note_change(&at);
            events.push(event);
        }
        if !restored.is_empty() {
            let mut event = Activity::new(&novel, "cover_restored", at.clone());
            event.covers = restored;
            events.push(event);
        }
        novel.last_check = Some(at);
        novel.error = errors.join("\n");
        novel.failures = if errors.is_empty() {
            0
        } else {
            novel.failures.saturating_add(1)
        };
        let delay = u64::from(interval) * 60_000;
        let delay = if errors.is_empty() {
            delay
        } else {
            retry.max(delay.min(60_000 * 2_u64.pow(novel.failures.saturating_sub(1).min(10))))
        };
        novel.next_check = Utc::now().timestamp_millis() + delay as i64;
        self.update(|s| {
            let target = s
                .novels
                .iter_mut()
                .find(|n| n.id == novel.id)
                .context("Новелла не найдена.")?;
            *target = novel.clone();
            resolve_initial_title(s, &novel);
            s.append(events);
            Ok(())
        })?;
        let store = self.store.lock().unwrap();
        let global = &store.profile.status_notifications;
        let policy = novel.status_notifications.as_ref().unwrap_or(global);
        let mut notices = self.notices.lock().unwrap();
        if let Some(change) =
            transition.filter(|change| policy.enabled && policy.targets.contains(&change.to))
        {
            notices.push(Notice {
                id: Some(novel.id.clone()),
                title: match change.to.as_str() {
                    "completed" => "Тайтл завершён",
                    "discontinued" => "Выпуск тайтла остановлен",
                    "delayed" => "Выпуск тайтла задерживается",
                    _ => "Выпуск тайтла возобновлён",
                }
                .into(),
                body: format!(
                    "{}\n{} → {}",
                    novel.title,
                    label(&change.from),
                    label(&change.to)
                ),
                silent: !global.sound,
            });
        }
        if new_count > 0 && !initial && !adding && store.profile.notifications {
            notices.push(Notice {
                id: Some(novel.id),
                title: "Сохранены новые обложки".into(),
                body: format!("{} · {new_count} PNG", novel.title),
                silent: true,
            });
        }
        Ok(())
    }

    pub fn root(&self) -> PathBuf {
        self.store.lock().unwrap().profile.root.clone()
    }

    pub fn file(&self, id: &str, hash: &str) -> Result<PathBuf> {
        if !archive::valid_hash(hash) {
            bail!("Неверный файл.");
        }
        let store = self.store.lock().unwrap();
        let novel = store
            .profile
            .novels
            .iter()
            .find(|n| n.id == id)
            .or_else(|| store.profile.retired.get(id))
            .context("Новелла не найдена.")?;
        let entry = novel
            .history
            .iter()
            .find(|e| e.hash == hash && archive::known_file(e, novel))
            .context("Изображение не найдено в архиве.")?;
        if !fs::symlink_metadata(&entry.file).is_ok_and(|metadata| metadata.file_type().is_file()) {
            bail!("Файл недоступен. Запустите проверку, чтобы восстановить его.");
        }
        Ok(entry.file.clone())
    }

    pub fn site(&self, id: &str) -> Result<String> {
        let store = self.store.lock().unwrap();
        let novel = store
            .profile
            .novels
            .iter()
            .find(|n| n.id == id)
            .or_else(|| store.profile.retired.get(id))
            .context("Новелла не найдена.")?;
        Ok(parse_novel_url(&novel.url)?.1)
    }

    pub fn preview(&self, id: &str, hash: &str) -> Result<Vec<u8>> {
        let original = self.file(id, hash)?;
        let cache = self
            .store
            .lock()
            .unwrap()
            .directory
            .join("previews")
            .join(format!("{hash}.jpg"));
        if let Ok(bytes) = fs::read(&cache) {
            return Ok(bytes);
        }
        let _gate = self.preview_gate.lock().unwrap();
        if let Ok(bytes) = fs::read(&cache) {
            return Ok(bytes);
        }
        let bytes = archive::preview(&original)?;
        atomic_write(&cache, &bytes)?;
        Ok(bytes)
    }
}

fn string(value: &Value) -> Result<&str> {
    value.as_str().ok_or_else(|| anyhow!("Ожидается строка."))
}
fn source_label(kind: &str) -> &str {
    if kind == "original" {
        "Оригинал"
    } else {
        "Обложка"
    }
}

fn resolve_initial_title(profile: &mut Profile, novel: &Novel) {
    let placeholder = format!("Novelpia {}", novel.id);
    if novel.title == placeholder {
        return;
    }
    for event in &mut profile.activity {
        if event.novel_id == novel.id && event.title == placeholder && event.kind == "watch_added" {
            event.title.clone_from(&novel.title);
        }
    }
}

fn observe(novel: &mut Novel, status: Option<String>, reason: String) -> Option<Transition> {
    novel.status_reason = reason;
    novel.status_available = Some(false);
    let next = status.filter(|status| STATUSES.contains(&status.as_str()))?;
    let at = now();
    novel.status_available = Some(true);
    novel.status_observed_at = Some(at.clone());
    let from = novel
        .status
        .replace(next.clone())
        .filter(|old| old != &next && STATUSES.contains(&old.as_str()))?;
    let change = Transition {
        id: format!("{}:{at}", novel.id),
        novel_id: novel.id.clone(),
        title: novel.title.clone(),
        from,
        to: next,
        at,
    };
    novel.status_history.push(change.clone());
    let excess = novel.status_history.len().saturating_sub(200);
    novel.status_history.drain(..excess);
    Some(change)
}

fn update_settings(s: &mut Profile, patch: Value) -> Result<()> {
    for (key, value) in patch.as_object().context("Неверные настройки.")? {
        match key.as_str() {
            "paused" => s.paused = value.as_bool().context("Неверная пауза.")?,
            "login" => s.login = value.as_bool().context("Неверный автозапуск.")?,
            "notifications" => {
                s.notifications = value.as_bool().context("Неверные настройки уведомлений.")?
            }
            "root" => {
                let root = PathBuf::from(string(value)?);
                if !root.is_absolute() || !root.is_dir() {
                    bail!("Выберите существующую папку архива.");
                }
                s.root = root;
            }
            "interval" => {
                let interval = value
                    .as_u64()
                    .filter(|i| (5..=1440).contains(i))
                    .context("Интервал — целое число от 5 до 1440 минут.")?;
                s.interval = interval as u32;
                for novel in &mut s.novels {
                    novel.next_check = novel
                        .next_check
                        .min(Utc::now().timestamp_millis() + i64::from(s.interval) * 60_000);
                }
            }
            "statusNotifications" => {
                let policy: Policy = serde_json::from_value(value.clone())?;
                policy.validate()?;
                s.status_notifications = policy;
            }
            "theme" => s.theme = choice(value, &["light", "dark", "system"])?,
            "collectionSort" => s.collection_sort = choice(value, &["changed", "title"])?,
            "collectionStatus" => {
                s.collection_status = choice(
                    value,
                    &[
                        "all",
                        "completed",
                        "discontinued",
                        "delayed",
                        "ongoing",
                        "unknown",
                    ],
                )?
            }
            "collectionLayout" => s.collection_layout = choice(value, &["grid", "list"])?,
            _ => bail!("Неизвестная настройка."),
        }
    }
    Ok(())
}

fn choice(value: &Value, options: &[&str]) -> Result<String> {
    let value = string(value)?;
    if !options.contains(&value) {
        bail!("Неверное значение настройки.");
    }
    Ok(value.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_status_and_unknown_checks_never_generate_transitions() {
        let mut novel = Novel::default();
        assert!(observe(&mut novel, Some("ongoing".into()), String::new()).is_none());
        assert!(observe(&mut novel, None, "unknown".into()).is_none());
        assert_eq!(novel.status.as_deref(), Some("ongoing"));
        let transition = observe(&mut novel, Some("completed".into()), String::new()).unwrap();
        assert_eq!(transition.from, "ongoing");
        assert_eq!(transition.to, "completed");
        assert!(observe(&mut novel, Some("completed".into()), String::new()).is_none());
    }

    #[test]
    fn first_capture_is_silent_then_rename_status_and_replacement_are_logged() {
        let dir = tempfile::tempdir().unwrap();
        let monitor = Monitor::open(dir.path().join("profile")).unwrap();
        let root = dir.path().join("archive");
        fs::create_dir(&root).unwrap();
        monitor
            .update(|s| {
                s.root = root.clone();
                s.novels.push(Novel {
                    id: "1".into(),
                    url: "https://novelpia.com/novel/1".into(),
                    title: "Novelpia 1".into(),
                    ..Default::default()
                });
                Ok(())
            })
            .unwrap();
        let check = |title: &str, badge: &str, color, adding| {
            use image::ImageEncoder;
            let mut png = Vec::new();
            image::codecs::png::PngEncoder::new(&mut png)
                .write_image(&[color, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
                .unwrap();
            let novel = monitor.store.lock().unwrap().profile.novels[0].clone();
            monitor.perform_check(novel, &root, 30, adding, |_, image| {
                Ok(if image { png.clone() } else {
                    format!(r#"<div class="epnew-novel-title">{title}</div><div class="epnew-writer"><p class="in-writer">Author</p><p class="in-badge"><span>PLUS</span>{badge}</p></div><img class="cover_img" src="//images.novelpia.com/imagebox/cover/demo.file">"#).into_bytes()
                })
            }).unwrap();
        };
        check("Book", "", 7, true);
        assert!(monitor.drain_notices().is_empty());
        assert_eq!(monitor.snapshot()["activity"][0]["initial"], true);
        check("Renamed", "<span>완결</span>", 8, false);
        let state = monitor.snapshot();
        let types: HashSet<_> = state["activity"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["type"].as_str().unwrap())
            .collect();
        assert_eq!(
            types,
            HashSet::from(["cover_saved", "title_renamed", "status_changed"])
        );
        assert_eq!(state["novels"][0]["history"].as_array().unwrap().len(), 2);
        let notices = monitor.drain_notices();
        assert_eq!(notices.len(), 2);
        assert!(notices.iter().all(|n| n.id.as_deref() == Some("1")));
        check("Renamed", "<span>완결</span>", 8, false);
        assert!(monitor.drain_notices().is_empty());
        assert_eq!(monitor.snapshot()["activity"], state["activity"]);
        assert_eq!(
            monitor.snapshot()["novels"][0]["lastChangedAt"],
            state["novels"][0]["lastChangedAt"]
        );
    }
}
