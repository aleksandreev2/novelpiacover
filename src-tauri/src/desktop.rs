use std::{
    env,
    ffi::OsString,
    fs, io,
    os::windows::{ffi::OsStringExt, process::CommandExt},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    },
    time::Duration,
};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use tauri::{
    http::{Method, Response, StatusCode},
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::{NewWindowResponse, PageLoadEvent},
    App, AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use windows::{
    core::{Interface, GUID, HSTRING},
    Data::Xml::Dom::XmlDocument,
    Win32::{
        Foundation::PROPERTYKEY,
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
                StructuredStorage::{
                    InitPropVariantFromCLSID, PropVariantChangeType, PROPVARIANT, PVCHF_DEFAULT,
                },
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READWRITE,
            },
            Variant::VT_LPWSTR,
            WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
        },
        UI::Shell::{
            FOLDERID_Programs, IShellLinkW, PropertiesSystem::IPropertyStore, SHGetKnownFolderPath,
            SetCurrentProcessExplicitAppUserModelID, ShellLink, KNOWN_FOLDER_FLAG,
        },
    },
    UI::Notifications::{NotificationSetting, ToastNotification, ToastNotificationManager},
};
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

use crate::monitor::{Monitor, Notice};

const APP_ID: &str = "com.novelpia.coverarchive";
const MAIN: &str = "main";
const ORIGIN: &str = "http://tauri.localhost";
const OPEN_LINK: &str = "novelpia-archive://open";
const TITLE_LINK: &str = "novelpia-archive://title/";
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

const BRIDGE: &str = r#"
if (window === window.top && window.location.origin === "http://tauri.localhost") {
  const invoke = (...args) => window.__TAURI__.core.invoke(...args);
  const subscribe = (name, callback, ready) => {
    let active = true;
    const binding = window.__TAURI__.event.listen(name, ({ payload }) => {
      if (active) callback(payload);
    });
    binding.then(() => {
      if (active && ready) return invoke("archive_ready");
    }).catch((error) => console.error(error));
    return () => {
      active = false;
      binding.then((unlisten) => unlisten()).catch((error) => console.error(error));
    };
  };
  Object.defineProperty(window, "archiveAPI", {
    value: Object.freeze({
      call: (action, payload) =>
        invoke("archive_action", { action, payload: payload ?? null })
          .catch((error) => { throw new Error(String(error)); }),
      subscribe: (callback) => subscribe("archive-changed", callback),
      subscribeErrors: (callback) => subscribe("archive-error", callback),
      subscribeSelection: (callback) => subscribe("archive-select", callback, true),
      imageUrl: (id, hash) =>
        "http://cover.localhost/" + encodeURIComponent(id) + "/" + encodeURIComponent(hash),
    }),
  });
}
"#;

#[derive(Debug, PartialEq, Eq)]
enum Activation<'a> {
    Open,
    Title(&'a str),
}

fn valid_id(id: &str) -> bool {
    (1..=12).contains(&id.len()) && !id.starts_with('0') && id.bytes().all(|b| b.is_ascii_digit())
}

fn activation(arg: &str) -> Option<Activation<'_>> {
    if arg == OPEN_LINK || arg == "novelpia-archive://open/" {
        return Some(Activation::Open);
    }
    let id = arg.strip_prefix(TITLE_LINK)?;
    valid_id(id).then_some(Activation::Title(id))
}

fn xml_text(text: &str) -> String {
    text.chars()
        .filter(|c| matches!(c, '\u{9}' | '\u{a}' | '\u{d}' | '\u{20}'..='\u{fffd}' | '\u{10000}'..='\u{10ffff}'))
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn toast_xml(id: Option<&str>, title: &str, body: &str, silent: bool) -> String {
    let launch = id
        .filter(|id| valid_id(id))
        .map_or_else(|| OPEN_LINK.to_owned(), |id| format!("{TITLE_LINK}{id}"));
    let audio = if silent {
        r#"<audio silent="true"/>"#
    } else {
        ""
    };
    let title = xml_text(title);
    let body = xml_text(body);
    format!(
        r#"<toast activationType="protocol" launch="{launch}"><visual><binding template="ToastGeneric"><text>{title}</text><text>{body}</text></binding></visual>{audio}</toast>"#
    )
}

fn show_toast(notice: &Notice) -> Result<()> {
    struct WinRt;
    impl Drop for WinRt {
        fn drop(&mut self) {
            // Balances the successful RoInitialize on this thread.
            unsafe { RoUninitialize() };
        }
    }
    // Notification delivery runs on a blocking worker, so use the MTA.
    unsafe { RoInitialize(RO_INIT_MULTITHREADED)? };
    let _winrt = WinRt;
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))?;
    if notifier.Setting()? != NotificationSetting::Enabled {
        bail!("Уведомления для приложения отключены в настройках Windows.");
    }
    let document = XmlDocument::new()?;
    document.LoadXml(&HSTRING::from(toast_xml(
        notice.id.as_deref(),
        &notice.title,
        &notice.body,
        notice.silent,
    )))?;
    let toast = ToastNotification::CreateToastNotification(&document)?;
    notifier.Show(&toast)?;
    Ok(())
}

fn register_shortcut(shortcut_path: &Path) -> Result<()> {
    const AUMID_KEY: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 5,
    };
    const ACTIVATOR_KEY: PROPERTYKEY = PROPERTYKEY {
        pid: 26,
        ..AUMID_KEY
    };
    // A stub activator keeps protocol toasts available in Notification Center.
    const ACTIVATOR: GUID = GUID::from_u128(0xd13f380a_88de_456b_9b0d_c8f1ee9e4b54);

    struct Com;
    impl Drop for Com {
        fn drop(&mut self) {
            // Balances the successful CoInitializeEx on this thread.
            unsafe { CoUninitialize() };
        }
    }
    // This installer-only branch runs before the Tauri event loop starts.
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        let _com = Com;
        let programs_path = SHGetKnownFolderPath(&FOLDERID_Programs, KNOWN_FOLDER_FLAG(0), None)?;
        let programs = PathBuf::from(OsString::from_wide(programs_path.as_wide()));
        CoTaskMemFree(Some(programs_path.0.cast()));
        let path = shortcut_path.canonicalize()?;
        if !path.starts_with(programs.canonicalize()?)
            || path
                .extension()
                .is_none_or(|ext| !ext.eq_ignore_ascii_case("lnk"))
        {
            bail!("Недопустимый путь к ярлыку в меню «Пуск».");
        }
        let executable = env::current_exe()?.canonicalize()?;
        let shortcut = HSTRING::from(shortcut_path.as_os_str());
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        let file: IPersistFile = link.cast()?;
        file.Load(&shortcut, STGM_READWRITE)?;
        let mut target = [0_u16; 32768];
        link.GetPath(&mut target, std::ptr::null_mut(), 0)?;
        let len = target
            .iter()
            .position(|&ch| ch == 0)
            .unwrap_or(target.len());
        let target = PathBuf::from(OsString::from_wide(&target[..len]));
        if target.canonicalize()? != executable {
            bail!("Ярлык ведёт к другому приложению.");
        }
        let store: IPropertyStore = link.cast()?;
        let mut identity = PROPVARIANT::default();
        PropVariantChangeType(&mut identity, &APP_ID.into(), PVCHF_DEFAULT, VT_LPWSTR)?;
        let activator = InitPropVariantFromCLSID(&ACTIVATOR)?;
        store.SetValue(&AUMID_KEY, &identity)?;
        store.SetValue(&ACTIVATOR_KEY, &activator)?;
        store.Commit()?;
        file.Save(&shortcut, true)?;
    }
    Ok(())
}

#[derive(Default)]
struct Selection {
    ready: bool,
    pending: Option<String>,
}

struct Desktop {
    monitor: Arc<Monitor>,
    can_login: bool,
    selection: Mutex<Selection>,
    warning: Mutex<String>,
    pause_item: MenuItem<tauri::Wry>,
    shutting_down: AtomicBool,
    operations: RwLock<()>,
    settings: Mutex<()>,
}

impl Desktop {
    fn snapshot(&self) -> Value {
        let mut snapshot = self.monitor.snapshot();
        snapshot["canLogin"] = json!(self.can_login);
        snapshot["notificationWarning"] = json!(*self.warning.lock().unwrap());
        snapshot
    }

    fn perform(&self, app: &AppHandle, action: &str, payload: Value) -> Result<Value> {
        let _operation = self.operations.read().unwrap();
        if self.shutting_down.load(Ordering::Acquire) {
            bail!("Архив закрывается.");
        }
        match action {
            "snapshot" => Ok(self.snapshot()),
            "choose-root" => {
                let root = self.monitor.root();
                let folder = if root.as_os_str().is_empty() {
                    app.path().picture_dir().unwrap_or_default()
                } else {
                    root
                };
                let mut dialog = rfd::FileDialog::new()
                    .set_title("Папка для архива обложек")
                    .set_directory(folder);
                let window = app.get_webview_window(MAIN);
                if let Some(window) = &window {
                    dialog = dialog.set_parent(window);
                }
                if let Some(folder) = dialog.pick_folder() {
                    self.monitor.action("settings", json!({ "root": folder }))?;
                }
                Ok(self.snapshot())
            }
            "settings" => {
                let _settings = self.settings.lock().unwrap();
                self.update_settings(payload)?;
                Ok(self.snapshot())
            }
            "test-notification" => {
                let snapshot = self.snapshot();
                let id = if payload.is_null() {
                    None
                } else {
                    let id = text_arg(&payload)?;
                    let found = snapshot["novels"]
                        .as_array()
                        .is_some_and(|novels| novels.iter().any(|novel| novel["id"] == id));
                    if !found {
                        bail!("Новелла не найдена.");
                    }
                    Some(id.to_owned())
                };
                let notice = Notice {
                    id,
                    title: "Novelpia: проверка уведомлений".into(),
                    body: "Уведомления об изменениях статуса тайтлов будут появляться здесь."
                        .into(),
                    silent: !snapshot["statusNotifications"]["sound"]
                        .as_bool()
                        .unwrap_or(true),
                };
                self.notify(app, &notice)?;
                Ok(json!({ "requested": true }))
            }
            "open-notification-settings" => {
                open::that("ms-settings:notifications")?;
                Ok(Value::Null)
            }
            "open-site" => {
                open::that(self.monitor.site(text_arg(&payload)?)?)?;
                Ok(Value::Null)
            }
            "open-file" | "show-file" => {
                let path = self
                    .monitor
                    .file(text_arg(&payload["id"])?, text_arg(&payload["hash"])?)?;
                if !path.is_file() {
                    bail!("Файл недоступен. Запустите проверку, чтобы восстановить его.");
                }
                if action == "show-file" {
                    let mut arg = OsString::from("/select,\"");
                    arg.push(&path);
                    arg.push("\"");
                    Command::new("explorer.exe").raw_arg(arg).spawn()?;
                } else {
                    open::that(&path)?;
                }
                Ok(Value::Null)
            }
            "open-root" => {
                let root = self.monitor.root();
                if root.as_os_str().is_empty() {
                    bail!("Сначала выберите папку.");
                }
                open::that(root)?;
                Ok(Value::Null)
            }
            "add" | "check" | "remove" | "novel-notifications" | "activity-read" => {
                self.monitor.action(action, payload)?;
                Ok(self.snapshot())
            }
            _ => bail!("Неизвестное действие."),
        }
    }

    fn update_settings(&self, payload: Value) -> Result<()> {
        let settings = payload.as_object().context("Недопустимая настройка.")?;
        if settings.keys().any(|key| {
            !matches!(
                key.as_str(),
                "interval"
                    | "paused"
                    | "notifications"
                    | "login"
                    | "statusNotifications"
                    | "theme"
                    | "collectionSort"
                    | "collectionStatus"
                    | "collectionLayout"
            )
        }) {
            bail!("Недопустимая настройка.");
        }
        let Some(login) = payload.get("login") else {
            self.monitor.action("settings", payload)?;
            return Ok(());
        };
        let login = login.as_bool().context("Неверное значение автозапуска.")?;
        let current_login = self.monitor.snapshot()["login"].as_bool().unwrap_or(false);
        if login == current_login {
            self.monitor.action("settings", payload)?;
            return Ok(());
        }
        if !self.can_login {
            bail!("Автозапуск доступен в готовой сборке.");
        }

        let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(RUN_KEY)?;
        let previous = match key.get_raw_value(APP_ID) {
            Ok(value) => Some(value),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if login {
            let mut command = OsString::from("\"");
            command.push(env::current_exe()?);
            command.push("\" --hidden");
            key.set_value(APP_ID, &command)?;
        } else if previous.is_some() {
            key.delete_value(APP_ID)?;
        }
        if let Err(error) = self.monitor.action("settings", payload) {
            if let Some(value) = previous {
                key.set_raw_value(APP_ID, &value)?;
            } else if login {
                key.delete_value(APP_ID)?;
            }
            return Err(error);
        }
        Ok(())
    }

    fn notify(&self, app: &AppHandle, notice: &Notice) -> Result<()> {
        let result = show_toast(notice).context("Windows не показала уведомление");
        let message = result
            .as_ref()
            .err()
            .map(|e| format!("{e:#}"))
            .unwrap_or_default();
        let mut warning = self.warning.lock().unwrap();
        if *warning != message {
            *warning = message;
            drop(warning);
            let _ = app.emit_to(MAIN, "archive-changed", self.snapshot());
        }
        result
    }

    fn changed(&self, app: &AppHandle) {
        for notice in self.monitor.drain_notices() {
            if let Err(error) = self.notify(app, &notice) {
                report(app, &error);
            }
        }
        let snapshot = self.snapshot();
        let _ = self
            .pause_item
            .set_text(pause_label(snapshot["paused"] == true));
        let _ = app.emit_to(MAIN, "archive-changed", snapshot);
    }
}

fn text_arg(value: &Value) -> Result<&str> {
    value.as_str().context("Неверный параметр запроса.")
}

fn trusted_window(window: &WebviewWindow) -> Result<()> {
    let url = window.url()?;
    if window.label() != MAIN || !app_url(&url) {
        bail!("Недопустимый источник запроса.");
    }
    Ok(())
}

fn app_url(url: &tauri::Url) -> bool {
    url.origin().ascii_serialization() == ORIGIN
        && matches!(url.path(), "/" | "/index.html")
        && url.username().is_empty()
        && url.password().is_none()
}

#[tauri::command]
async fn archive_action(
    window: WebviewWindow,
    action: String,
    payload: Value,
) -> Result<Value, String> {
    trusted_window(&window).map_err(|e| format!("{e:#}"))?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Desktop>().perform(&app, &action, payload)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn archive_ready(window: WebviewWindow, state: State<'_, Desktop>) -> Result<(), String> {
    trusted_window(&window).map_err(|e| format!("{e:#}"))?;
    let mut selection = state.selection.lock().unwrap();
    selection.ready = true;
    if let Some(id) = selection.pending.take() {
        let _ = window.emit("archive-select", id);
    }
    Ok(())
}

fn pause_label(paused: bool) -> &'static str {
    if paused {
        "Продолжить наблюдение"
    } else {
        "Приостановить наблюдение"
    }
}

fn reveal(app: &AppHandle, activation: Option<Activation<'_>>) {
    if let Some(Activation::Title(id)) = activation {
        if let Some(desktop) = app.try_state::<Desktop>() {
            let mut selection = desktop.selection.lock().unwrap();
            if !selection.ready || app.emit_to(MAIN, "archive-select", id).is_err() {
                selection.pending = Some(id.to_owned());
            }
        }
    }
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn report(app: &AppHandle, error: &anyhow::Error) {
    let _ = app.emit_to(MAIN, "archive-error", format!("{error:#}"));
}

fn start_tick(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        let desktop = app.state::<Desktop>();
        {
            let _operation = desktop.operations.read().unwrap();
            if desktop.shutting_down.load(Ordering::Acquire) {
                break;
            }
            if let Err(error) = desktop.monitor.tick() {
                report(&app, &error);
            }
        }
        std::thread::sleep(Duration::from_secs(15));
    });
}

fn quit(app: &AppHandle) {
    let desktop = app.state::<Desktop>();
    if desktop.shutting_down.swap(true, Ordering::AcqRel) {
        return;
    }
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.hide();
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let desktop = app.state::<Desktop>();
        let _operations = desktop.operations.write().unwrap();
        desktop.monitor.wait_for_idle();
        desktop.monitor.set_changed(|| {});
        app.exit(0);
    });
}

fn install_tray(app: &App, pause_item: &MenuItem<tauri::Wry>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Открыть архив обложек", true, None::<&str>)?;
    let check = MenuItem::with_id(app, "check", "Проверить все сейчас", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let exit = MenuItem::with_id(app, "exit", "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, pause_item, &check, &separator, &exit])?;
    let mut tray = TrayIconBuilder::with_id("archive")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Novelpia • Архив обложек")
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                reveal(tray.app_handle(), None);
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => reveal(app, None),
            "exit" => quit(app),
            id @ ("check" | "pause") => {
                let app = app.clone();
                let pause = id == "pause";
                tauri::async_runtime::spawn_blocking(move || {
                    let desktop = app.state::<Desktop>();
                    let result = if pause {
                        let paused = desktop.monitor.snapshot()["paused"] == true;
                        desktop.perform(&app, "settings", json!({ "paused": !paused }))
                    } else {
                        desktop.perform(&app, "check", Value::Null)
                    };
                    if let Err(error) = result {
                        report(&app, &error);
                    }
                });
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn profile_path() -> Result<(PathBuf, bool)> {
    if let Some(profile) = env::var_os("NOVELPIA_PROFILE") {
        let profile = PathBuf::from(profile);
        if !profile.is_absolute() {
            bail!("NOVELPIA_PROFILE должен быть абсолютным путём.");
        }
        return Ok((profile, false));
    }
    let path = PathBuf::from(env::var_os("APPDATA").context("APPDATA is missing")?);
    Ok((path.join("Novelpia Cover Archive"), !cfg!(debug_assertions)))
}

pub fn run() -> Result<()> {
    let args = env::args_os().skip(1).collect::<Vec<_>>();
    if let [flag, shortcut] = args.as_slice() {
        if flag == "--register-shortcut" {
            return register_shortcut(Path::new(shortcut));
        }
    }
    // Windows needs the process ID to match the notification shortcut.
    unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(APP_ID))? };
    let hidden = args.iter().any(|arg| arg == "--hidden");
    let initial = args
        .iter()
        .filter_map(|arg| arg.to_str())
        .find_map(activation);
    let initial_title = match initial {
        Some(Activation::Title(id)) => Some(id.to_owned()),
        _ => None,
    };
    let show = !hidden || initial.is_some();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let activation = args.iter().skip(1).find_map(|arg| activation(arg));
            if activation.is_some() || !args.iter().any(|arg| arg == "--hidden") {
                reveal(app, activation);
            }
        }))
        .invoke_handler(tauri::generate_handler![archive_action, archive_ready])
        .register_asynchronous_uri_scheme_protocol("cover", |context, request, responder| {
            let desktop = context.app_handle().try_state::<Desktop>();
            let monitor = desktop.map(|desktop| desktop.monitor.clone());
            tauri::async_runtime::spawn_blocking(move || {
                let preview = (|| {
                    if request.method() != Method::GET {
                        return None;
                    }
                    let (id, hash) = request.uri().path().strip_prefix('/')?.split_once('/')?;
                    if !valid_id(id)
                        || hash.len() != 64
                        || !hash.bytes().all(|b| b.is_ascii_hexdigit())
                    {
                        return None;
                    }
                    monitor?.preview(id, hash).ok()
                })();
                let response = if let Some(bytes) = preview {
                    Response::builder()
                        .header("Content-Type", "image/jpeg")
                        .header("Cache-Control", "public,max-age=31536000,immutable")
                        .body(bytes)
                } else {
                    Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .body(Vec::new())
                };
                responder.respond(response.expect("static response headers"));
            });
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(move |app| {
            let (profile, can_login) = profile_path()?;
            let browser_data = profile.join("webview2");
            fs::create_dir_all(&browser_data)?;
            let monitor = Arc::new(Monitor::open(profile)?);
            let pause = MenuItem::with_id(
                app,
                "pause",
                pause_label(monitor.snapshot()["paused"] == true),
                true,
                None::<&str>,
            )?;
            app.manage(Desktop {
                monitor: monitor.clone(),
                can_login,
                selection: Mutex::new(Selection {
                    ready: false,
                    pending: initial_title,
                }),
                warning: Mutex::new(String::new()),
                pause_item: pause.clone(),
                shutting_down: AtomicBool::new(false),
                operations: RwLock::new(()),
                settings: Mutex::new(()),
            });
            WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
                .title("Novelpia Cover Archive")
                .inner_size(1180.0, 810.0)
                .min_inner_size(900.0, 650.0)
                .initialization_script(BRIDGE)
                .data_directory(browser_data)
                .visible(false)
                .on_navigation(app_url)
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .on_page_load(|window, event| {
                    if event.event() == PageLoadEvent::Started {
                        window.state::<Desktop>().selection.lock().unwrap().ready = false;
                    }
                })
                .build()?;
            install_tray(app, &pause)?;
            let handle = app.handle().clone();
            monitor.set_changed(move || handle.state::<Desktop>().changed(&handle));
            if show {
                reveal(app.handle(), None);
            }
            start_tick(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{activation, toast_xml, Activation};

    #[test]
    fn notification_activation_accepts_only_canonical_title_links() {
        assert_eq!(
            activation("novelpia-archive://title/434103"),
            Some(Activation::Title("434103"))
        );
        assert_eq!(
            activation("novelpia-archive://open"),
            Some(Activation::Open)
        );
        for bad in [
            "https://novelpia-archive/title/434103",
            "novelpia-archive://title/0",
            "novelpia-archive://title/0434103",
            "novelpia-archive://title/1234567890123",
            "novelpia-archive://title/434103?select=2",
            "novelpia-archive://title/434103/2",
            "novelpia-archive://title/４３４１０３",
        ] {
            assert_eq!(activation(bad), None, "{bad}");
        }
    }

    #[test]
    fn notification_markup_keeps_title_text_out_of_the_xml_structure() {
        let xml = toast_xml(Some("434103"), "A & B", "<тост>\0", true);
        assert!(
            xml.contains(r#"activationType="protocol" launch="novelpia-archive://title/434103""#)
        );
        assert!(xml.contains("<text>A &amp; B</text><text>&lt;тост&gt;</text>"));
        assert!(xml.contains(r#"<audio silent="true"/>"#));
        assert!(!toast_xml(None, "Test", "Sound", false).contains("<audio"));
    }
}
