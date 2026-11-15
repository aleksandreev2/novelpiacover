use std::{
    collections::{BTreeSet, HashMap, HashSet},
    env, fs,
    io::{self, BufRead, BufReader, Read, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use chrono::{DateTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::model::atomic_write;

const INTERVAL: TimeDelta = TimeDelta::minutes(30);
const MIN_INTERVAL: TimeDelta = TimeDelta::minutes(1);
const MAX_RESPONSE: u64 = 4 * 1024 * 1024;
const SITE: &str = "https://ranobelib.me/ru/book/";

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Status {
    Completed,
    Ongoing,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ObservationState {
    Known,
    Empty,
    Unknown,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostic {
    stage: String,
    code: String,
    message: String,
    http_status: Option<u16>,
    title_id: Option<u64>,
    page: Option<u32>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Attempt {
    operation: Operation,
    started_at: DateTime<Utc>,
    finished_at: DateTime<Utc>,
    diagnostic: Option<Diagnostic>,
    counts: Option<ScanCounts>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanCounts {
    completed: usize,
    known: usize,
    #[serde(default)]
    empty: usize,
    unknown: usize,
    not_due: usize,
}

impl ScanCounts {
    fn for_scan(scan: &Scan) -> Self {
        let mut counts = Self::default();
        for item in &scan.items {
            if item.status == Status::Completed {
                counts.completed += 1;
            } else {
                match item.observation.as_ref().map(|value| value.state) {
                    Some(ObservationState::Known) => counts.known += 1,
                    Some(ObservationState::Empty) => counts.empty += 1,
                    Some(ObservationState::Unknown) => counts.unknown += 1,
                    None => counts.not_due += 1,
                }
            }
        }
        counts
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Observation {
    state: ObservationState,
    scheduled: Option<u32>,
    last_publish_at: Option<DateTime<Utc>>,
    checked_at: DateTime<Utc>,
    next_check_at: DateTime<Utc>,
    shared: Option<bool>,
    message: Option<String>,
    diagnostic: Option<Diagnostic>,
}

impl Observation {
    fn upgrade_empty_chapter_list(&mut self) {
        // Earlier versions emitted this message only for a valid, empty API list.
        if self.state == ObservationState::Unknown
            && self.message.as_deref() == Some("RanobeLIB вернул пустой список глав.")
        {
            if let Some(next) = self.checked_at.checked_add_signed(TimeDelta::days(2)) {
                self.state = ObservationState::Empty;
                self.next_check_at = next;
                self.message = None;
                self.diagnostic = None;
            }
        }
    }

    fn recheck_at(&self) -> Option<DateTime<Utc>> {
        (self.state != ObservationState::Unknown || self.diagnostic.is_some())
            .then_some(self.next_check_at)
    }
}

#[derive(Clone, Deserialize, Serialize)]
struct Title {
    id: u64,
    slug: String,
    title: String,
    status: Status,
    observation: Option<Observation>,
}

fn valid_slug(id: u64, slug: &str) -> bool {
    id > 0
        && slug.split_once("--").is_some_and(|(prefix, name)| {
            prefix == id.to_string()
                && !name.is_empty()
                && slug.len() <= 300
                && name
                    .chars()
                    .all(|ch| ch.is_alphanumeric() || matches!(ch, '-' | '_'))
        })
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct Profile {
    enabled: bool,
    connected: bool,
    last_scan_at: Option<DateTime<Utc>>,
    next_scan_at: Option<DateTime<Utc>>,
    titles: Vec<Title>,
    final_loaded: BTreeSet<u64>,
    last_attempt: Option<Attempt>,
}

impl Profile {
    fn apply_scan(&mut self, mut scan: Scan) -> Result<()> {
        let mut ids = HashSet::new();
        if scan.items.iter().any(|item| {
            !valid_slug(item.id, &item.slug)
                || item.title.trim().is_empty()
                || !ids.insert(item.id)
                || item.observation.as_ref().is_some_and(|observation| {
                    observation.state == ObservationState::Known
                        && (observation.scheduled.is_none() || observation.shared.is_none())
                })
        }) {
            bail!("RanobeLIB вернул неполные данные о тайтлах.");
        }
        let previous: HashMap<_, _> = self.titles.iter().map(|title| (title.id, title)).collect();
        for title in &mut scan.items {
            if title.status == Status::Ongoing && title.observation.is_none() {
                title.observation = previous
                    .get(&title.id)
                    .filter(|prior| prior.status == title.status && prior.slug == title.slug)
                    .and_then(|prior| prior.observation.clone());
            }
        }
        self.connected = true;
        self.last_scan_at = Some(scan.scanned_at);
        // Refresh the catalogue regularly. Chapter lists also have individual due dates.
        let next = scan
            .items
            .iter()
            .filter_map(|item| {
                item.observation
                    .as_ref()
                    .map(|observation| observation.next_check_at)
            })
            .min()
            .unwrap_or(scan.scanned_at + INTERVAL);
        self.next_scan_at =
            Some(next.clamp(scan.scanned_at + MIN_INTERVAL, scan.scanned_at + INTERVAL));
        self.titles = scan.items;
        Ok(())
    }
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Login,
    Check,
}

impl Operation {
    fn argument(self) -> &'static str {
        match self {
            Self::Login => "login",
            Self::Check => "scan",
        }
    }

    fn timeout(self) -> Duration {
        match self {
            Self::Login => Duration::from_secs(660),
            Self::Check => Duration::from_secs(360),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scan {
    scanned_at: DateTime<Utc>,
    items: Vec<Title>,
}

#[derive(Default)]
struct State {
    profile: Profile,
    busy: Option<Operation>,
    started_at: Option<DateTime<Utc>>,
    error: Option<String>,
}

pub struct RanobeLib {
    file: PathBuf,
    browser_profile: PathBuf,
    state: Mutex<State>,
}

impl RanobeLib {
    pub fn open(directory: &Path) -> Self {
        let file = directory.join("ranobelib.json");
        let state = match fs::read(&file) {
            Ok(bytes) => match serde_json::from_slice::<Profile>(&bytes) {
                Ok(mut profile) => {
                    for observation in profile
                        .titles
                        .iter_mut()
                        .filter_map(|title| title.observation.as_mut())
                    {
                        observation.upgrade_empty_chapter_list();
                    }
                    State {
                        profile,
                        ..State::default()
                    }
                }
                Err(_) => State {
                    error: Some("Не удалось прочитать сохранённые настройки RanobeLIB.".into()),
                    ..State::default()
                },
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => State::default(),
            Err(_) => State {
                error: Some("Не удалось открыть настройки RanobeLIB.".into()),
                ..State::default()
            },
        };
        Self {
            file,
            browser_profile: directory.join("ranobelib-browser"),
            state: Mutex::new(state),
        }
    }

    pub fn snapshot(&self) -> Value {
        let state = self.state.lock().unwrap();
        let profile = &state.profile;
        let titles: Vec<_> = profile
            .titles
            .iter()
            .map(|title| {
                let mut value = json!(title);
                value["finalLoaded"] = json!(profile.final_loaded.contains(&title.id));
                value
            })
            .collect();
        json!({
            "enabled": profile.enabled,
            "connected": profile.connected,
            "busy": state.busy,
            "startedAt": state.started_at,
            "lastAttempt": profile.last_attempt,
            "lastScanAt": profile.last_scan_at,
            "nextScanAt": if profile.enabled && profile.connected { profile.next_scan_at } else { None },
            "error": state.error,
            "titles": titles
        })
    }

    fn save(&self, state: &mut State, profile: Profile) -> Result<()> {
        atomic_write(&self.file, &serde_json::to_vec(&profile)?)
            .context("Не удалось сохранить наблюдение RanobeLIB.")?;
        state.profile = profile;
        Ok(())
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        let mut profile = state.profile.clone();
        if enabled && !profile.connected {
            bail!("Сначала войдите в RanobeLIB.");
        }
        profile.enabled = enabled;
        self.save(&mut state, profile)
    }

    pub fn set_final(&self, id: u64, loaded: bool) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        let mut profile = state.profile.clone();
        if !profile
            .titles
            .iter()
            .any(|title| title.id == id && title.status == Status::Ongoing)
        {
            bail!("Активный перевод команды не найден.");
        }
        if loaded {
            profile.final_loaded.insert(id);
        } else {
            profile.final_loaded.remove(&id);
        }
        self.save(&mut state, profile)
    }

    pub fn site(&self, id: u64) -> Result<String> {
        let state = self.state.lock().unwrap();
        let title = state
            .profile
            .titles
            .iter()
            .find(|title| title.id == id && valid_slug(id, &title.slug))
            .context("Тайтл RanobeLIB не найден.")?;
        Ok(format!("{SITE}{}", title.slug))
    }

    pub fn begin(&self, operation: Operation, automatic: bool) -> Result<bool> {
        let mut state = self.state.lock().unwrap();
        if state.busy.is_some() {
            return Ok(false);
        }
        if automatic
            && (!state.profile.enabled
                || !state.profile.connected
                || state
                    .profile
                    .next_scan_at
                    .is_some_and(|next| next > Utc::now()))
        {
            return Ok(false);
        }
        if operation == Operation::Check && !state.profile.connected {
            bail!("Сначала войдите в RanobeLIB.");
        }
        state.busy = Some(operation);
        state.started_at = Some(Utc::now());
        state.error = None;
        Ok(true)
    }

    pub fn run(&self, operation: Operation, force: bool, stopping: &AtomicBool) {
        let input = {
            let state = self.state.lock().unwrap();
            let known: Vec<_> = state.profile.titles.iter().map(|title| json!({
                "id": title.id,
                "status": title.status,
                "checkedAt": title.observation.as_ref().map(|observation| observation.checked_at),
                "nextCheckAt": title.observation.as_ref().and_then(Observation::recheck_at),
            })).collect();
            json!({ "known": known, "force": force })
        };
        let result = invoke_worker(operation, &self.browser_profile, &input, stopping);
        let mut state = self.state.lock().unwrap();
        state.busy = None;
        let finished_at = Utc::now();
        let started_at = state.started_at.take().unwrap_or(finished_at);
        if stopping.load(Ordering::Acquire) {
            return;
        }
        let mut profile = state.profile.clone();
        let mut diagnostic = None;
        let mut counts = None;
        let error = match result {
            Ok(reply) if reply["ok"] == true => {
                if operation == Operation::Login {
                    profile.connected = true;
                    profile.next_scan_at = None;
                    None
                } else {
                    serde_json::from_value::<Scan>(reply)
                        .context("Не удалось прочитать результаты проверки RanobeLIB.")
                        .and_then(|scan| {
                            let summary = ScanCounts::for_scan(&scan);
                            profile.apply_scan(scan)?;
                            counts = Some(summary);
                            Ok(())
                        })
                        .err()
                        .map(|error| error.to_string())
                }
            }
            Ok(reply) => {
                let code = reply["code"].as_str().unwrap_or_default();
                diagnostic = serde_json::from_value(reply["diagnostic"].clone()).ok();
                if matches!(code, "login_required" | "team_access") {
                    profile.connected = false;
                }
                let message = match code {
                    "login_required" => "Войдите в RanobeLIB, чтобы продолжить проверку.",
                    "team_access" => "Войдите с аккаунтом, у которого есть доступ к управлению командой «Дом Некроманта».",
                    "browser_missing" => "Для входа в RanobeLIB нужен Microsoft Edge или Google Chrome.",
                    "rate_limited" => "RanobeLIB временно ограничил запросы. Следующая автоматическая проверка через час.",
                    "cancelled" => "Вход в RanobeLIB отменён.",
                    "schema" => "Не удалось подтвердить данные RanobeLIB. Проверьте позже.",
                    _ => "RanobeLIB временно недоступен. Проверьте соединение и повторите попытку.",
                };
                if code == "rate_limited" {
                    profile.next_scan_at = Some(Utc::now() + TimeDelta::hours(1));
                }
                Some(message.into())
            }
            Err(error) => Some(error.to_string()),
        };
        if error.is_some() && operation == Operation::Check && profile.connected {
            let retry = Utc::now() + INTERVAL;
            profile.next_scan_at = Some(profile.next_scan_at.map_or(retry, |next| next.max(retry)));
        }
        let attempt = Attempt {
            operation,
            started_at,
            finished_at,
            diagnostic: diagnostic.or_else(|| {
                error.as_ref().map(|message| Diagnostic {
                    stage: "app".into(),
                    code: "app_error".into(),
                    message: message.clone(),
                    http_status: None,
                    title_id: None,
                    page: None,
                })
            }),
            counts,
        };
        profile.last_attempt = Some(attempt.clone());
        let next_scan = profile.next_scan_at;
        state.error = self
            .save(&mut state, profile)
            .err()
            .map(|error| {
                // Keep the in-process backoff even when the settings file is unavailable.
                state.profile.next_scan_at = next_scan;
                state.profile.last_attempt = Some(attempt);
                error.to_string()
            })
            .or(error);
    }
}

fn worker_paths() -> Result<(PathBuf, PathBuf)> {
    let executable = env::current_exe()?;
    let directory = executable
        .parent()
        .context("Не найдена папка приложения.")?
        .join("ranobelib");
    let node = directory.join("node.exe");
    let script = directory.join("worker/ranobelib.cjs");
    if node.is_file() && script.is_file() {
        return Ok((node, script));
    }
    if cfg!(debug_assertions) {
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../worker/ranobelib.cjs");
        if script.is_file() {
            return Ok((PathBuf::from("node.exe"), script));
        }
    }
    bail!("Не найден модуль RanobeLIB. Установите полную сборку приложения.")
}

fn invoke_worker(
    operation: Operation,
    profile: &Path,
    input: &Value,
    stopping: &AtomicBool,
) -> Result<Value> {
    let (node, script) = worker_paths()?;
    let mut child = Command::new(node)
        .arg(script)
        .arg(operation.argument())
        .arg(profile)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("Не удалось запустить модуль RanobeLIB.")?;
    let mut stdin = child.stdin.take().expect("piped worker stdin");
    let stdout = child.stdout.take().expect("piped worker stdout");
    let reader = thread::spawn(move || -> io::Result<String> {
        let mut line = String::new();
        BufReader::new(stdout)
            .take(MAX_RESPONSE)
            .read_line(&mut line)?;
        Ok(line)
    });
    if operation == Operation::Check && writeln!(stdin, "{input}").is_err() {
        let _ = child.kill();
        let _ = child.wait();
        bail!("Не удалось передать параметры проверки RanobeLIB.");
    }
    let deadline = Instant::now() + operation.timeout();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if stopping.load(Ordering::Acquire) || Instant::now() >= deadline {
            let _ = writeln!(stdin, "{{\"cancel\":true}}");
            drop(stdin);
            let grace = Instant::now() + Duration::from_secs(4);
            while child.try_wait()?.is_none() && Instant::now() < grace {
                thread::sleep(Duration::from_millis(100));
            }
            let _ = child.kill();
            let _ = child.wait();
            bail!("Истекло время ожидания RanobeLIB.");
        }
        thread::sleep(Duration::from_millis(100));
    };
    if !status.success() {
        bail!("Модуль RanobeLIB завершился с ошибкой.");
    }
    let line = reader
        .join()
        .map_err(|_| anyhow::anyhow!("Не удалось получить ответ RanobeLIB."))??;
    serde_json::from_str(&line).context("Некорректный ответ модуля RanobeLIB.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_only_one_operation_and_auto_checks_only_when_connected_and_enabled() {
        let directory = tempfile::tempdir().unwrap();
        let service = RanobeLib::open(directory.path());
        assert!(!service.begin(Operation::Check, true).unwrap());
        assert!(service.begin(Operation::Check, false).is_err());
        assert!(service.begin(Operation::Login, false).unwrap());
        assert!(!service.begin(Operation::Login, false).unwrap());
        {
            let mut state = service.state.lock().unwrap();
            state.busy = None;
            state.profile.connected = true;
        }
        service.set_enabled(true).unwrap();
        assert!(service.begin(Operation::Check, true).unwrap());
        assert_eq!(service.snapshot()["busy"], "check");
    }

    #[test]
    fn scan_preserves_local_mark_and_only_allows_matching_title_urls() {
        let directory = tempfile::tempdir().unwrap();
        let service = RanobeLib::open(directory.path());
        let now = Utc::now();
        let scan = |slug: &str, title: &str| Scan {
            scanned_at: now,
            items: vec![Title {
                id: 123260,
                slug: slug.to_owned(),
                title: title.to_owned(),
                status: Status::Ongoing,
                observation: None,
            }],
        };
        {
            let mut state = service.state.lock().unwrap();
            state
                .profile
                .apply_scan(scan("123260--yuusha", "Прежнее название"))
                .unwrap();
        }
        service.set_final(123260, true).unwrap();
        {
            let mut state = service.state.lock().unwrap();
            assert!(state
                .profile
                .apply_scan(scan("42--another", "Чужой тайтл"))
                .is_err());
            assert!(state
                .profile
                .apply_scan(scan("123260--../another", "Чужой тайтл"))
                .is_err());
            state
                .profile
                .apply_scan(scan("123260--new-slug", "Новое название"))
                .unwrap();
        }
        assert_eq!(service.snapshot()["titles"][0]["finalLoaded"], true);
        assert_eq!(
            service.site(123260).unwrap(),
            format!("{SITE}123260--new-slug")
        );
        assert!(service.site(42).is_err());
        assert_eq!(
            RanobeLib::open(directory.path()).snapshot()["titles"][0]["finalLoaded"],
            true
        );
    }

    #[test]
    fn refresh_reuses_fresh_observation_only_for_the_same_ongoing_title() {
        let now = Utc::now();
        let title = |status, slug: &str, observation| Title {
            id: 42,
            slug: slug.to_owned(),
            title: "Тайтл".to_owned(),
            status,
            observation,
        };
        let observation = Observation {
            state: ObservationState::Known,
            scheduled: Some(3),
            last_publish_at: None,
            checked_at: now,
            next_check_at: now + TimeDelta::minutes(3),
            shared: Some(false),
            message: None,
            diagnostic: None,
        };
        let mut profile = Profile::default();
        for (item, expected) in [
            (
                title(Status::Ongoing, "42--slug", Some(observation)),
                Some(3),
            ),
            (title(Status::Ongoing, "42--slug", None), Some(3)),
            (title(Status::Ongoing, "42--renamed", None), None),
            (title(Status::Completed, "42--renamed", None), None),
        ] {
            profile
                .apply_scan(Scan {
                    scanned_at: now,
                    items: vec![item],
                })
                .unwrap();
            assert_eq!(
                profile.titles[0]
                    .observation
                    .as_ref()
                    .and_then(|value| value.scheduled),
                expected
            );
            if expected.is_some() {
                assert_eq!(profile.next_scan_at, Some(now + TimeDelta::minutes(3)));
            }
        }
    }

    #[test]
    fn upgrades_only_old_confirmed_empty_lists_for_the_full_recheck_interval() {
        let now = Utc::now();
        let mut observation = Observation {
            state: ObservationState::Unknown,
            scheduled: None,
            last_publish_at: None,
            checked_at: now,
            next_check_at: now + TimeDelta::minutes(15),
            shared: None,
            message: Some("В ответе RanobeLIB нет списка записей.".into()),
            diagnostic: None,
        };
        observation.upgrade_empty_chapter_list();
        assert!(observation.state == ObservationState::Unknown);
        assert_eq!(observation.next_check_at, now + TimeDelta::minutes(15));
        observation.message = Some("RanobeLIB вернул пустой список глав.".into());
        observation.upgrade_empty_chapter_list();
        assert!(observation.state == ObservationState::Empty);
        assert_eq!(observation.recheck_at(), Some(now + TimeDelta::days(2)));
        assert!(observation.scheduled.is_none());
        assert!(observation.message.is_none());
    }
}
