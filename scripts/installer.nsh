!define WEBVIEW_CLIENT "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
!define PROTOCOL_KEY "Software\Classes\novelpia-archive"
!define LOGIN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

!macro customInit
  ReadRegStr $R0 HKLM "Software\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $R0 == ""
  ${OrIf} $R0 == "0.0.0.0"
    ReadRegStr $R0 HKCU "${WEBVIEW_CLIENT}" "pv"
  ${EndIf}
  ${If} $R0 == ""
  ${OrIf} $R0 == "0.0.0.0"
    InitPluginsDir
    File /oname=$PLUGINSDIR\WebView2Setup.exe "$%NOVELPIA_WEBVIEW_BOOTSTRAP%"
    ExecWait '"$PLUGINSDIR\WebView2Setup.exe" /silent /install' $R0
    ${If} $R0 != 0
      MessageBox MB_ICONSTOP "Не удалось установить Microsoft Edge WebView2. Проверьте подключение к интернету и повторите установку." /SD IDOK
      SetErrorLevel 1
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  WriteRegStr HKCU "${PROTOCOL_KEY}" "" "URL:Novelpia Cover Archive"
  WriteRegStr HKCU "${PROTOCOL_KEY}" "URL Protocol" ""
  WriteRegStr HKCU "${PROTOCOL_KEY}\shell\open\command" "" '$\"$appExe$\" $\"%1$\"'
  ReadRegStr $R0 HKCU "${LOGIN_KEY}" "${APP_ID}"
  ${If} $R0 != ""
    WriteRegStr HKCU "${LOGIN_KEY}" "${APP_ID}" '$\"$appExe$\" --hidden'
  ${EndIf}
  ExecWait '"$appExe" --register-shortcut "$newStartMenuLink"' $R0
  ${If} $R0 != 0
    MessageBox MB_ICONEXCLAMATION "Не удалось зарегистрировать уведомления Windows. Приложение установлено." /SD IDOK
  ${EndIf}
!macroend

!macro customUnInstall
  ReadRegStr $R0 HKCU "${PROTOCOL_KEY}\shell\open\command" ""
  ${If} $R0 == '$\"$INSTDIR\NovelpiaCoverArchive.exe$\" $\"%1$\"'
    DeleteRegKey HKCU "${PROTOCOL_KEY}"
  ${EndIf}
  ${IfNot} ${isUpdated}
    ReadRegStr $R0 HKCU "${LOGIN_KEY}" "${APP_ID}"
    ${If} $R0 == '$\"$INSTDIR\NovelpiaCoverArchive.exe$\" --hidden'
      DeleteRegValue HKCU "${LOGIN_KEY}" "${APP_ID}"
    ${EndIf}
  ${EndIf}
!macroend
