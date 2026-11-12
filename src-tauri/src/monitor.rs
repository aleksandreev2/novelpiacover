use crate::{
    archive::{self, Archive},
    model::{
        atomic_write, label, now, Activity, Cover, Novel, Policy, Profile, Rename, Store,
        Transition, STATUSES,
    },
    novelpia::{inspect_page, parse_novel_url, safe_folder, Client, FetchError},
};
use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use serde_json::{json, Value};
use std::{
    collections::{HashSet, VecDeque},
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
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
    checks: Mutex<Checks>,
    archive_write: Mutex<()>,
    revision: AtomicU64,
    preview_gate: Mutex<()>,
    notices: Mutex<Vec<Notice>>,
    callback: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

struct CheckJob {
    id: String,
    automatic: bool,
    adding: bool,
}

#[derive(Default)]
struct Checks {
    pending: VecDeque<CheckJob>,
    current: Option<String>,
    completed: usize,
    running: bool,
    cancelled: bool,
    stopping: bool,
}

impl Checks {
    fn enqueue(&mut self, job: CheckJob) {
        if self.stopping || (!self.cancelled && self.current.as_ref() == Some(&job.id)) {
            return;
        }
        if let Some(queued) = self.pending.iter_mut().find(|queued| queued.id == job.id) {
            queued.automatic &= job.automatic;
            return;
        }
        if job.adding {
            self.pending.push_front(job);
        } else {
            self.pending.push_back(job);
        }
    }
}

impl Monitor {
    pub fn open(profile: PathBuf) -> Result<Self> {
        let store = Store::open(profile)?;
        fs::create_dir_all(store.directory.join("previews"))?;
        Ok(Self {
            store: Mutex::new(store),
            client: Client::new()?,
            checks: Mutex::new(Checks::default()),
            archive_write: Mutex::new(()),
            revision: AtomicU64::new(0),
            preview_gate: Mutex::new(()),
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

    pub fn stop_checks(&self) {
        let mut checks = self.checks.lock().unwrap();
        checks.stopping = true;
        checks.pending.clear();
    }

    pub fn drain_notices(&self) -> Vec<Notice> {
        std::mem::take(&mut *self.notices.lock().unwrap())
    }

    pub fn snapshot(&self) -> Value {
        let store = self.store.lock().unwrap();
        let mut state = serde_json::to_value(&store.profile).expect("profile JSON");
        let checks = self.checks.lock().unwrap();
        let total = checks.completed
            + checks.pending.len()
            + usize::from(checks.current.is_some() && !checks.cancelled);
        state["busy"] = json!(checks
            .current
            .iter()
            .filter(|_| !checks.cancelled)
            .collect::<Vec<_>>());
        state["queued"] = json!(checks.pending.iter().map(|job| &job.id).collect::<Vec<_>>());
        state["checkProgress"] = if total == 0 {
            Value::Null
        } else {
            json!({"completed": checks.completed, "total": total})
        };
        state["revision"] = json!(self.revision.fetch_add(1, Ordering::Relaxed));
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

    pub fn action(&self, action: &str, payload: Value) -> Result<Value> {
        if action == "snapshot" {
            return Ok(self.snapshot());
        }
        match action {
            "check" => {
                let id = if payload.is_null() {
                    None
                } else {
                    Some(string(&payload)?)
                };
                let store = self.store.lock().unwrap();
                if store.profile.root.as_os_str().is_empty() {
                    bail!("Выберите папку архива.");
                }
                if id.is_some_and(|id| !store.profile.novels.iter().any(|novel| novel.id == id)) {
                    bail!("Новелла не найдена.");
                }
                let mut checks = self.checks.lock().unwrap();
                for novel in &store.profile.novels {
                    if id.is_none_or(|id| id == novel.id) {
                        checks.enqueue(CheckJob {
                            id: novel.id.clone(),
                            automatic: false,
                            adding: false,
                        });
                    }
                }
            }
            "add" => {
                let (id, url) = parse_novel_url(string(&payload)?)?;
                let mut store = self.store.lock().unwrap();
                store.update(|s| {
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
                self.checks.lock().unwrap().enqueue(CheckJob {
                    id,
                    automatic: false,
                    adding: true,
                });
            }
            "remove" => self.remove(&payload)?,
            "settings" => {
                let pause = payload["paused"].as_bool() == Some(true);
                let mut store = self.store.lock().unwrap();
                store.update(|s| update_settings(s, payload))?;
                if pause {
                    self.checks
                        .lock()
                        .unwrap()
                        .pending
                        .retain(|job| !job.automatic);
                }
            }
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
                let mut store = self.store.lock().unwrap();
                if sequence > store.profile.activity_sequence {
                    bail!("Неверная отметка прочтения.");
                }
                if sequence <= store.profile.activity_read_sequence {
                    drop(store);
                    return Ok(self.snapshot());
                }
                store.update(|s| {
                    s.activity_read_sequence = sequence;
                    Ok(())
                })?;
            }
            _ => bail!("Неизвестное действие."),
        }
        self.changed();
        Ok(self.snapshot())
    }

    fn remove(&self, payload: &Value) -> Result<()> {
        let (id, delete_archive) = if let Some(id) = payload.as_str() {
            (id, false)
        } else {
            (
                string(&payload["id"])?,
                payload["deleteArchive"]
                    .as_bool()
                    .context("Неверная настройка удаления архива.")?,
            )
        };
        let _archive_write = self.archive_write.lock().unwrap();
        if delete_archive {
            let (novel, root) = {
                let store = self.store.lock().unwrap();
                let novel = store
                    .profile
                    .novels
                    .iter()
                    .find(|novel| novel.id == id)
                    .context("Новелла не найдена.")?;
                (novel.clone(), store.profile.root.clone())
            };
            archive::recycle_folders(&novel, &root)?;
        }
        let mut store = self.store.lock().unwrap();
        let saved = store.update(|profile| {
            let index = profile
                .novels
                .iter()
                .position(|novel| novel.id == id)
                .context("Новелла не найдена.")?;
            let mut novel = profile.novels.remove(index);
            let mut event = Activity::new(&novel, "watch_removed", now());
            if delete_archive {
                novel.history.clear();
                novel.latest_hash = None;
                novel.last_saved = 0;
                event.archive_deleted = true;
                for previous in profile
                    .activity
                    .iter_mut()
                    .filter(|e| e.novel_id == id && !e.covers.is_empty())
                {
                    previous.covers.clear();
                    previous.archive_deleted = true;
                }
            }
            profile.append(vec![event]);
            profile.retired.insert(novel.id.clone(), novel);
            Ok(())
        });
        if delete_archive {
            saved.context(
                "Не удалось обновить профиль после обработки архива. Проверьте корзину Windows.",
            )?;
        } else {
            saved?;
        }
        let mut checks = self.checks.lock().unwrap();
        checks.pending.retain(|job| job.id != id);
        if checks.current.as_deref() == Some(id) {
            checks.cancelled = true;
        }
        Ok(())
    }

    pub fn tick(&self) -> Result<()> {
        {
            let store = self.store.lock().unwrap();
            let profile = &store.profile;
            let mut checks = self.checks.lock().unwrap();
            if checks.running || checks.stopping {
                return Ok(());
            }
            if !profile.paused && !profile.root.as_os_str().is_empty() {
                let now = Utc::now().timestamp_millis();
                for novel in profile
                    .novels
                    .iter()
                    .filter(|novel| novel.next_check <= now)
                {
                    checks.enqueue(CheckJob {
                        id: novel.id.clone(),
                        automatic: true,
                        adding: false,
                    });
                }
            }
        }
        self.run_checks()
    }

    pub fn run_checks(&self) -> Result<()> {
        self.run_checks_with(|url, image| self.client.fetch(url, image))
    }

    fn current_check_cancelled(&self) -> bool {
        let checks = self.checks.lock().unwrap();
        checks.cancelled || checks.stopping
    }

    fn run_checks_with(
        &self,
        fetch: impl Fn(&str, bool) -> std::result::Result<Vec<u8>, FetchError>,
    ) -> Result<()> {
        {
            let mut checks = self.checks.lock().unwrap();
            if checks.running || checks.pending.is_empty() {
                return Ok(());
            }
            checks.running = true;
        }
        let mut result = Ok(());
        loop {
            let job = {
                let mut checks = self.checks.lock().unwrap();
                let job = checks.pending.pop_front();
                if let Some(job) = &job {
                    checks.current = Some(job.id.clone());
                    checks.cancelled = false;
                } else {
                    checks.running = false;
                    checks.completed = 0;
                }
                job
            };
            self.changed();
            let Some(job) = job else { return result };
            let novel = {
                let store = self.store.lock().unwrap();
                let profile = &store.profile;
                profile
                    .novels
                    .iter()
                    .find(|n| {
                        n.id == job.id
                            && (!job.automatic
                                || (!profile.paused
                                    && n.next_check <= Utc::now().timestamp_millis()))
                    })
                    .cloned()
            };
            let attempted = novel.is_some();
            if let Some(novel) = novel {
                if let Err(error) = self.perform_check(novel, job.adding, &fetch) {
                    result = Err(error);
                }
            }
            {
                let mut checks = self.checks.lock().unwrap();
                checks.current = None;
                if attempted && !checks.cancelled && !checks.stopping {
                    checks.completed += 1;
                }
            }
            self.changed();
        }
    }

    fn perform_check(
        &self,
        mut novel: Novel,
        adding: bool,
        fetch: impl Fn(&str, bool) -> std::result::Result<Vec<u8>, FetchError>,
    ) -> Result<()> {
        if self.current_check_cancelled() {
            return Ok(());
        }
        let response = match fetch(&novel.url, false) {
            Ok(page) => {
                let data = inspect_page(&String::from_utf8_lossy(&page));
                let mut images = Vec::with_capacity(data.sources.len());
                for source in &data.sources {
                    if self.current_check_cancelled() {
                        return Ok(());
                    }
                    images.push(fetch(&source.url, true));
                }
                Ok((data, images))
            }
            Err(error) => Err(error),
        };
        // Only local archive writes and removals share this lock.
        let _archive_write = self.archive_write.lock().unwrap();
        let root = {
            let store = self.store.lock().unwrap();
            if self.current_check_cancelled()
                || !store.profile.novels.iter().any(|n| n.id == novel.id)
            {
                return Ok(());
            }
            store.profile.root.clone()
        };
        let mut errors = Vec::new();
        let mut retry = 0;
        let mut events = Vec::new();
        let mut transition = None;
        let mut fresh = Vec::new();
        let mut restored = Vec::new();
        let initial = novel.history.is_empty();
        let known: HashSet<_> = novel.history.iter().map(|e| e.hash.clone()).collect();
        match response {
            Err(error) => {
                retry = error.retry_after_ms;
                errors.push(error.to_string());
            }
            Ok((data, images)) => {
                if let Some(title) = data.title.filter(|title| !title.is_empty()) {
                    let old = std::mem::replace(&mut novel.title, title);
                    if old != novel.title
                        && !old.is_empty()
                        && old != format!("Novelpia {}", novel.id)
                    {
                        let mut event = Activity::new(&novel, "title_renamed", now());
                        event.from = Some(old.clone());
                        event.to = Some(novel.title.clone());
                        novel.note_change(&event.at);
                        novel.title_history.push(Rename {
                            from: old,
                            to: novel.title.clone(),
                            at: event.at.clone(),
                        });
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
                    match Archive::open(&novel, &root) {
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
                            for (source, image) in novel.sources.iter().zip(images) {
                                let image = match image {
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
                                match archive.save(&novel, source, &image) {
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
        self.update(|s| {
            let delay = u64::from(s.interval) * 60_000;
            let delay = if errors.is_empty() {
                delay
            } else {
                retry.max(delay.min(60_000 * 2_u64.pow(novel.failures.saturating_sub(1).min(10))))
            };
            novel.next_check = Utc::now().timestamp_millis() + delay as i64;
            let target = s
                .novels
                .iter_mut()
                .find(|n| n.id == novel.id)
                .context("Новелла не найдена.")?;
            novel
                .status_notifications
                .clone_from(&target.status_notifications);
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
    fn collection_settings_and_add_complete_while_a_check_waits_for_the_page() {
        use std::{sync::mpsc, thread, time::Duration};

        let dir = tempfile::tempdir().unwrap();
        let monitor = Monitor::open(dir.path().join("profile")).unwrap();
        let root = dir.path().join("archive");
        fs::create_dir(&root).unwrap();
        let novel = Novel {
            id: "1".into(),
            url: "https://novelpia.com/novel/1".into(),
            ..Default::default()
        };
        monitor
            .update(|profile| {
                profile.root = root.clone();
                profile.novels.push(novel.clone());
                Ok(())
            })
            .unwrap();
        let (fetching, started) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let (saved, finished) = mpsc::channel();
        monitor.action("check", json!("1")).unwrap();
        thread::scope(|scope| {
            let monitor = &monitor;
            scope.spawn(move || {
                monitor
                    .run_checks_with(|url, _| {
                        if url.ends_with("/1") {
                            fetching.send(()).unwrap();
                            released.recv().unwrap();
                        }
                        Ok(Vec::new())
                    })
                    .unwrap();
            });
            if let Err(error) = started.recv_timeout(Duration::from_secs(3)) {
                drop(release);
                panic!("check did not start: {error}");
            }
            scope.spawn(move || {
                let result = monitor
                    .action("settings", json!({"collectionLayout": "list"}))
                    .and_then(|_| {
                        monitor.action(
                            "novel-notifications",
                            json!({
                                "id": "1", "policy": {"enabled": false, "targets": []}
                            }),
                        )
                    })
                    .and_then(|_| monitor.action("add", json!("https://novelpia.com/novel/2")));
                saved.send(result).unwrap();
            });
            let while_fetching = finished.recv_timeout(Duration::from_secs(2));
            release.send(()).unwrap();
            let snapshot = while_fetching
                .expect("actions should complete during the network request")
                .unwrap();
            assert_eq!(snapshot["collectionLayout"], "list");
            assert_eq!(snapshot["novels"][1]["id"], "2");
            assert_eq!(snapshot["busy"], json!(["1"]));
            assert_eq!(snapshot["queued"], json!(["2"]));
            assert_eq!(
                snapshot["checkProgress"],
                json!({"completed": 0, "total": 2})
            );
        });
        let snapshot = monitor.snapshot();
        assert_eq!(
            snapshot["novels"][0]["statusNotifications"]["enabled"],
            false
        );
        assert!(snapshot["novels"][1]["lastCheck"].is_string());
        assert!(snapshot["checkProgress"].is_null());
    }

    #[test]
    fn a_removed_check_cannot_write_into_a_new_watch_of_the_same_title() {
        use std::{sync::mpsc, thread, time::Duration};

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("archive");
        fs::create_dir(&root).unwrap();
        let monitor = Monitor::open(dir.path().join("profile")).unwrap();
        monitor.action("settings", json!({ "root": root })).unwrap();
        let url = json!("https://novelpia.com/novel/1");
        monitor.action("add", url.clone()).unwrap();

        let (started, waiting) = mpsc::channel();
        let (release, released) = mpsc::channel();
        thread::scope(|scope| {
            let monitor = &monitor;
            scope.spawn(move || {
                let first = std::cell::Cell::new(true);
                monitor.run_checks_with(|_, image| {
                    assert!(!image, "a cancelled check must not start an image request");
                    let page = if first.replace(false) {
                        started.send(()).unwrap();
                        released.recv().unwrap();
                        r#"<div class="epnew-novel-title">Старый ответ</div><img class="cover_img" src="//images.novelpia.com/imagebox/cover/demo.file">"#
                    } else {
                        r#"<div class="epnew-novel-title">Актуальный ответ</div>"#
                    };
                    Ok(page.as_bytes().to_vec())
                }).unwrap();
            });
            let result = waiting
                .recv_timeout(Duration::from_secs(3))
                .map_err(anyhow::Error::from)
                .and_then(|_| monitor.action("remove", json!("1")))
                .and_then(|_| monitor.action("add", url));
            let _ = release.send(());
            result.unwrap();
        });
        let snapshot = monitor.snapshot();
        assert_eq!(snapshot["novels"][0]["title"], "Актуальный ответ");
        assert_eq!(snapshot["novels"][0]["titleHistory"], json!([]));
    }

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
            monitor.perform_check(novel, adding, |_, image| {
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
        assert_eq!(state["novels"][0]["titleHistory"][0]["from"], "Book");
        assert_eq!(state["novels"][0]["titleHistory"][0]["to"], "Renamed");
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
