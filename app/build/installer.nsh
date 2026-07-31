; Custom assisted-installer page: one checkbox that seeds the tray app's
; "Register with OpenCode" setting on first launch (consumeInstallOptions in
; main.js reads and deletes the seed). Fresh setups only — when
; ~\.haven-proxy\config.json already exists the page is skipped and nothing
; is written, so updates/reinstalls never clobber a choice made in-app.
!include LogicLib.nsh
!include nsDialogs.nsh

; The uninstaller pass never inserts our macros, so an unconditional Var would
; trip NSIS's unused-variable warning (treated as an error by electron-builder).
!ifndef BUILD_UNINSTALLER
  Var RegisterOpencodeCheckbox
  Var RegisterOpencodeState
!endif

!macro customPageAfterChangeDir
  Page custom registerOpencodePageCreate registerOpencodePageLeave

  Function registerOpencodePageCreate
    IfFileExists "$PROFILE\.haven-proxy\config.json" 0 +2
      Abort ; existing setup — the choice lives in the tray menu now
    !insertmacro MUI_HEADER_TEXT "OpenCode integration" "Make Haven models available in OpenCode."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateCheckbox} 0 16u 100% 12u "&Add Haven as a provider in OpenCode (recommended)"
    Pop $RegisterOpencodeCheckbox
    ${NSD_Check} $RegisterOpencodeCheckbox
    ${NSD_CreateLabel} 0 36u 100% 24u "Haven models then show up in OpenCode automatically. You can change this anytime from the tray menu."
    Pop $0
    nsDialogs::Show
  FunctionEnd

  Function registerOpencodePageLeave
    ${NSD_GetState} $RegisterOpencodeCheckbox $RegisterOpencodeState
  FunctionEnd
!macroend

!macro customInstall
  ${IfNot} ${FileExists} "$PROFILE\.haven-proxy\config.json"
    ; Empty state (page skipped, e.g. silent install) defaults to registering.
    StrCpy $0 "true"
    ${If} $RegisterOpencodeState == ${BST_UNCHECKED}
      StrCpy $0 "false"
    ${EndIf}
    CreateDirectory "$PROFILE\.haven-proxy"
    ClearErrors
    FileOpen $1 "$PROFILE\.haven-proxy\install-options.json" w
    ${IfNot} ${Errors}
      FileWrite $1 '{"registerOpencode": $0}$\n'
      FileClose $1
    ${EndIf}
  ${EndIf}
!macroend
