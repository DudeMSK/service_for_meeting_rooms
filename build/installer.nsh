!ifndef BUILD_UNINSTALLER

!include "nsDialogs.nsh"
!include "LogicLib.nsh"

Var EwsConfigDialog
Var EwsEmailField
Var EwsUsernameField
Var EwsPasswordField
Var EwsServerField
Var EwsMailboxesField
Var EwsTokenField

Var EwsEmailValue
Var EwsUsernameValue
Var EwsPasswordValue
Var EwsServerValue
Var EwsMailboxesValue
Var EwsTokenValue
Var EwsPageShown

; Function definitions live INSIDE this macro on purpose: the macro body is only pasted
; into the script where assistedInstaller.nsh inserts it (after MUI2.nsh is !included),
; so !insertmacro MUI_HEADER_TEXT below actually resolves — it does not if called from a
; plain top-level Function in this file, because this whole file is prepended before
; installer.nsi/MUI2.nsh are processed.
!macro customPageAfterChangeDir
  Page custom EwsConfigPageCreate EwsConfigPageLeave

  Function EwsConfigPageCreate
    ; Skip this page entirely when upgrading an existing installation (per-user or
    ; per-machine) — only ask for EWS credentials on a genuinely fresh install.
    ReadRegStr $0 HKLM "Software\${APP_GUID}" InstallLocation
    ReadRegStr $1 HKCU "Software\${APP_GUID}" InstallLocation
    ${If} $0 != ""
    ${OrIf} $1 != ""
      Abort
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "Подключение к Exchange" "Нужно только при первой настройке — можно оставить пустым"

    nsDialogs::Create 1018
    Pop $EwsConfigDialog
    ${If} $EwsConfigDialog == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0u 100% 9u "Заполните при первой настройке — иначе оставьте поля пустыми."
    Pop $0

    ${NSD_CreateLabel} 0 14u 46% 8u "Email сервисной учетной записи"
    Pop $0
    ${NSD_CreateText} 0 23u 46% 12u ""
    Pop $EwsEmailField

    ${NSD_CreateLabel} 52% 14u 48% 8u "Имя пользователя (UPN)"
    Pop $0
    ${NSD_CreateText} 52% 23u 48% 12u ""
    Pop $EwsUsernameField

    ${NSD_CreateLabel} 0 39u 46% 8u "Пароль"
    Pop $0
    ${NSD_CreatePassword} 0 48u 46% 12u ""
    Pop $EwsPasswordField

    ${NSD_CreateLabel} 52% 39u 48% 8u "Сервер (mail.example.org)"
    Pop $0
    ${NSD_CreateText} 52% 48u 48% 12u ""
    Pop $EwsServerField

    ${NSD_CreateLabel} 0 64u 100% 8u "Календари для чтения (адреса через запятую)"
    Pop $0
    ${NSD_CreateText} 0 73u 100% 12u ""
    Pop $EwsMailboxesField

    ${NSD_CreateLabel} 0 89u 100% 8u "Токен GitHub для автообновления (необязательно)"
    Pop $0
    ${NSD_CreatePassword} 0 98u 100% 12u ""
    Pop $EwsTokenField

    StrCpy $EwsPageShown "1"
    nsDialogs::Show
  FunctionEnd

  Function EwsConfigPageLeave
    ${NSD_GetText} $EwsEmailField $EwsEmailValue
    ${NSD_GetText} $EwsUsernameField $EwsUsernameValue
    ${NSD_GetText} $EwsPasswordField $EwsPasswordValue
    ${NSD_GetText} $EwsServerField $EwsServerValue
    ${NSD_GetText} $EwsMailboxesField $EwsMailboxesValue
    ${NSD_GetText} $EwsTokenField $EwsTokenValue
  FunctionEnd
!macroend

!macro customInstall
  ; Only write .env if our page was actually shown — guards against any edge case where
  ; Leave might run without a real dialog (e.g. nsDialogs::Create failure).
  ${If} $EwsPageShown == "1"
    ${If} $EwsEmailValue != ""
    ${AndIf} $EwsEmailValue != "error"
      FileOpen $9 "$INSTDIR\.env" w
      FileWrite $9 "EWS_EMAIL=$EwsEmailValue$\r$\n"
      FileWrite $9 "EWS_USERNAME=$EwsUsernameValue$\r$\n"
      FileWrite $9 "EWS_PASSWORD=$EwsPasswordValue$\r$\n"
      FileWrite $9 "EWS_SERVER=$EwsServerValue$\r$\n"
      FileWrite $9 "EWS_AUTH=ntlm$\r$\n"
      FileWrite $9 "EWS_MAILBOXES=$EwsMailboxesValue$\r$\n"
      ${If} $EwsTokenValue != ""
      ${AndIf} $EwsTokenValue != "error"
        FileWrite $9 "GH_TOKEN=$EwsTokenValue$\r$\n"
      ${EndIf}
      FileClose $9
    ${ElseIf} $EwsTokenValue != ""
    ${AndIf} $EwsTokenValue != "error"
      ; No EWS credentials entered, but a token was — append it to a fresh/existing .env
      ; without touching any EWS_* lines that might already be there.
      FileOpen $9 "$INSTDIR\.env" a
      FileWrite $9 "GH_TOKEN=$EwsTokenValue$\r$\n"
      FileClose $9
    ${EndIf}
  ${EndIf}
!macroend

!endif
