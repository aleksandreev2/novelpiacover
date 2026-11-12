use crate::novelpia::Source;
use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub const STATUSES: [&str; 4] = ["completed", "discontinued", "delayed", "ongoing"];
const ACTIVITY_LIMIT: usize = 500;

pub fn label(status: &str) -> &'static str {
    match status {
        "ongoing" => "Продолжается",
        "completed" => "Завершён",
        "discontinued" => "Выпуск остановлен",
        "delayed" => "Выпуск задерживается",
        _ => "Не определён",
    }
}

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn timestamp(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp_millis())
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Policy {
    pub enabled: bool,
    pub targets: Vec<String>,
    #[serde(default = "yes")]
    pub sound: bool,
}

fn yes() -> bool {
    true
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            enabled: true,
            targets: STATUSES.map(str::to_owned).to_vec(),
            sound: true,
        }
    }
}

impl Policy {
    pub fn validate(&self) -> Result<()> {
        let unique: HashSet<_> = self.targets.iter().collect();
        if self.targets.iter().any(|s| !STATUSES.contains(&s.as_str()))
            || unique.len() != self.targets.len()
        {
            bail!("Неверный список статусов для уведомлений.");
        }
        Ok(())
    }

    fn upgrade(&mut self) {
        if self.targets.len() == 3
            && ["completed", "discontinued", "ongoing"]
                .iter()
                .all(|s| self.targets.iter().any(|t| t == s))
        {
            self.targets.push("delayed".into());
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub hash: String,
    pub file: PathBuf,
    pub saved_at: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub kind: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub addressed_source: Option<bool>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Cover {
    pub hash: String,
    pub kind: String,
    pub width: u32,
    pub height: u32,
}

impl From<&Entry> for Cover {
    fn from(entry: &Entry) -> Self {
        Self {
            hash: entry.hash.clone(),
            kind: entry.kind.clone(),
            width: entry.width,
            height: entry.height,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub id: String,
    pub novel_id: String,
    pub title: String,
    pub from: String,
    pub to: String,
    pub at: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rename {
    pub from: String,
    pub to: String,
    pub at: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Novel {
    pub id: String,
    pub url: String,
    pub title: String,
    pub folder: String,
    pub history: Vec<Entry>,
    pub sources: Vec<Source>,
    pub latest_hash: Option<String>,
    pub next_check: i64,
    pub last_check: Option<String>,
    pub last_changed_at: Option<String>,
    pub last_saved: usize,
    pub failures: u32,
    pub error: String,
    pub status: Option<String>,
    pub status_available: Option<bool>,
    pub status_reason: String,
    pub status_observed_at: Option<String>,
    pub status_history: Vec<Transition>,
    pub title_history: Vec<Rename>,
    pub status_notifications: Option<Policy>,
}

impl Novel {
    pub fn note_change(&mut self, at: &str) {
        if let Some(time) = timestamp(at) {
            if self
                .last_changed_at
                .as_deref()
                .and_then(timestamp)
                .is_none_or(|old| old <= time)
            {
                self.last_changed_at = Some(at.to_owned());
            }
        }
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Activity {
    pub sequence: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub novel_id: String,
    pub title: String,
    pub at: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub covers: Vec<Cover>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    pub initial: bool,
    pub imported: bool,
    pub resumed: bool,
    pub archive_deleted: bool,
}

impl Activity {
    pub fn new(novel: &Novel, kind: &str, at: String) -> Self {
        Self {
            kind: kind.to_owned(),
            novel_id: novel.id.clone(),
            title: novel.title.clone(),
            at,
            ..Self::default()
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Profile {
    pub version: u32,
    pub root: PathBuf,
    pub interval: u32,
    pub paused: bool,
    pub login: bool,
    pub notifications: bool,
    pub status_notifications: Policy,
    pub status_policy_version: u32,
    pub activity_version: u32,
    pub activity: Vec<Activity>,
    pub activity_sequence: u64,
    pub activity_read_sequence: u64,
    pub novels: Vec<Novel>,
    pub retired: BTreeMap<String, Novel>,
    pub theme: String,
    pub collection_sort: String,
    pub collection_status: String,
    pub collection_layout: String,
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            version: 1,
            root: PathBuf::new(),
            interval: 30,
            paused: false,
            login: false,
            notifications: true,
            status_notifications: Policy::default(),
            status_policy_version: 0,
            activity_version: 0,
            activity: Vec::new(),
            activity_sequence: 0,
            activity_read_sequence: 0,
            novels: Vec::new(),
            retired: BTreeMap::new(),
            theme: "light".into(),
            collection_sort: "changed".into(),
            collection_status: "all".into(),
            collection_layout: "grid".into(),
        }
    }
}

impl Profile {
    pub fn append(&mut self, mut events: Vec<Activity>) {
        events.retain(|e| timestamp(&e.at).is_some());
        events.sort_by_key(|e| timestamp(&e.at));
        for mut event in events {
            self.activity_sequence += 1;
            event.sequence = self.activity_sequence;
            self.activity.push(event);
        }
        let excess = self.activity.len().saturating_sub(ACTIVITY_LIMIT);
        self.activity.drain(..excess);
    }

    fn upgrade(&mut self) {
        let mut events = Vec::new();
        let mut seen = HashSet::new();
        let mut renames = BTreeMap::<&str, Vec<Rename>>::new();
        for event in self
            .activity
            .iter()
            .filter(|event| event.kind == "title_renamed")
        {
            let (Some(from), Some(to)) = (&event.from, &event.to) else {
                continue;
            };
            if from != to && !from.is_empty() && !to.is_empty() && timestamp(&event.at).is_some() {
                renames.entry(&event.novel_id).or_default().push(Rename {
                    from: from.clone(),
                    to: to.clone(),
                    at: event.at.clone(),
                });
            }
        }
        if self.status_policy_version < 2 {
            self.status_notifications.upgrade();
        }
        for novel in self.novels.iter_mut().chain(self.retired.values_mut()) {
            if self.status_policy_version < 2 {
                if let Some(policy) = &mut novel.status_notifications {
                    policy.upgrade();
                }
            }
            let mut hashes = HashSet::new();
            let mut dates = Vec::new();
            if let Some(history) = renames.get(novel.id.as_str()) {
                for rename in history {
                    if !novel.title_history.contains(rename) {
                        novel.title_history.push(rename.clone());
                    }
                }
                novel
                    .title_history
                    .sort_by_key(|rename| timestamp(&rename.at));
            }
            dates.extend(novel.title_history.iter().map(|rename| rename.at.clone()));
            let import = self.activity_version == 0 && seen.insert(novel.id.clone());
            for entry in &novel.history {
                if hashes.insert(&entry.hash) && timestamp(&entry.saved_at).is_some() {
                    dates.push(entry.saved_at.clone());
                    if import {
                        let mut event = Activity::new(novel, "cover_saved", entry.saved_at.clone());
                        event.imported = true;
                        event.covers.push(Cover::from(entry));
                        events.push(event);
                    }
                }
            }
            for change in &novel.status_history {
                if change.from == change.to
                    || !STATUSES.contains(&change.from.as_str())
                    || !STATUSES.contains(&change.to.as_str())
                {
                    continue;
                }
                dates.push(change.at.clone());
                if import {
                    let mut event = Activity::new(novel, "status_changed", change.at.clone());
                    event.imported = true;
                    event.title = change.title.clone();
                    event.from = Some(change.from.clone());
                    event.to = Some(change.to.clone());
                    events.push(event);
                }
            }
            for date in dates {
                novel.note_change(&date);
            }
        }
        self.status_policy_version = 2;
        if self.activity_version == 0 {
            self.append(events);
            self.activity_read_sequence = self.activity_sequence;
            self.activity_version = 1;
        }
    }
}

pub fn atomic_write(file: &Path, bytes: &[u8]) -> Result<()> {
    let parent = file.parent().context("У файла нет родительской папки")?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    tmp.persist(file).map_err(|e| e.error)?;
    Ok(())
}

pub struct Store {
    pub profile: Profile,
    pub directory: PathBuf,
    pub recovered: bool,
}

impl Store {
    pub fn open(directory: PathBuf) -> Result<Self> {
        fs::create_dir_all(&directory)?;
        let primary = directory.join("settings.json");
        let backup = directory.join("settings.json.bak");
        let load = |file: &Path| -> Result<Profile> {
            let data: serde_json::Value = serde_json::from_slice(&fs::read(file)?)?;
            if data["version"] != 1 || !data["novels"].is_array() || !data["retired"].is_object() {
                bail!("Неподдерживаемые настройки.");
            }
            Ok(serde_json::from_value(data)?)
        };
        let missing = |error: &anyhow::Error| {
            error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
        };
        let (mut profile, recovered) = match load(&primary) {
            Ok(state) => (state, false),
            Err(primary_error) => match load(&backup) {
                Ok(state) => (state, true),
                Err(backup_error) if missing(&primary_error) && missing(&backup_error) => {
                    (Profile::default(), false)
                }
                Err(_) => {
                    return Err(anyhow!(
                        "Не удалось прочитать настройки и резервную копию. Папка: {}",
                        directory.display()
                    ))
                }
            },
        };
        profile.upgrade();
        Ok(Self {
            profile,
            directory,
            recovered,
        })
    }

    pub fn update(&mut self, change: impl FnOnce(&mut Profile) -> Result<()>) -> Result<()> {
        let mut next = self.profile.clone();
        change(&mut next)?;
        let file = self.directory.join("settings.json");
        if file.exists() {
            atomic_write(
                &self.directory.join("settings.json.bak"),
                &serde_json::to_vec_pretty(&self.profile)?,
            )?;
        }
        atomic_write(&file, &serde_json::to_vec_pretty(&next)?)?;
        self.profile = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_renames_before_the_global_activity_log_rolls_over() {
        let dir = tempfile::tempdir().unwrap();
        let before = "초월자들이 집착하는 성지의 주인이 되었다";
        let after = "초월자들을 타락시키는 모텔 주인이 되었다";
        let settings = serde_json::json!({
            "version": 1, "novels": [{"id": "1", "title": after}], "retired": {},
            "activityVersion": 1, "activitySequence": 1,
            "activity": [{"type": "title_renamed", "novelId": "1", "title": after,
                "from": before, "to": after, "at": "2026-11-12T00:00:00Z", "sequence": 1}]
        });
        fs::write(
            dir.path().join("settings.json"),
            serde_json::to_vec(&settings).unwrap(),
        )
        .unwrap();
        let mut store = Store::open(dir.path().to_owned()).unwrap();
        store
            .update(|profile| {
                let novel = profile.novels[0].clone();
                profile.append(
                    (0..=ACTIVITY_LIMIT)
                        .map(|_| Activity::new(&novel, "cover_saved", now()))
                        .collect(),
                );
                Ok(())
            })
            .unwrap();
        let store = Store::open(dir.path().to_owned()).unwrap();
        assert!(store
            .profile
            .activity
            .iter()
            .all(|e| e.kind != "title_renamed"));
        let history = &store.profile.novels[0].title_history;
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].from, before);
        assert_eq!(history[0].to, after);
    }

    #[test]
    fn migrates_legacy_titles_and_retired_covers_without_unread_events() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        fs::write(&file, br#"{"version":1,"root":"C:/Covers","novels":[{"id":"1","title":"Book","statusHistory":[{"id":"status-1","novelId":"1","title":"Book","from":"ongoing","to":"completed","at":"2026-11-02T00:00:00Z"}]}],"retired":{"2":{"id":"2","title":"Retired","history":[{"hash":"abc","file":"C:/Covers/book.png","savedAt":"2026-10-22T00:00:00Z","width":1,"height":1,"bytes":10,"kind":"original","source":""}]}}}"#).unwrap();
        let mut store = Store::open(dir.path().to_owned()).unwrap();
        assert_eq!(store.profile.activity.len(), 2);
        assert_eq!(store.profile.activity[0].novel_id, "2");
        assert_eq!(store.profile.activity_read_sequence, 2);
        assert_eq!(
            store.profile.novels[0].last_changed_at.as_deref(),
            Some("2026-11-02T00:00:00Z")
        );
        store
            .update(|profile| {
                profile.theme = "dark".into();
                Ok(())
            })
            .unwrap();
        let restarted = Store::open(dir.path().to_owned()).unwrap();
        assert_eq!(restarted.profile.activity.len(), 2);
        assert_eq!(restarted.profile.theme, "dark");
    }

    #[test]
    fn retains_only_latest_activity_with_stable_sequence() {
        let mut profile = Profile::default();
        let novel = Novel::default();
        profile.append(
            (0..510)
                .map(|_| Activity::new(&novel, "watch_added", now()))
                .collect(),
        );
        assert_eq!(profile.activity.len(), ACTIVITY_LIMIT);
        assert_eq!(profile.activity[0].sequence, 11);
        assert_eq!(profile.activity_sequence, 510);
    }
}
