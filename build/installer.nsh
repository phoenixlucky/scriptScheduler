!macro customInstall
  SetShellVarContext all
  SetOutPath "$INSTDIR"
  File "/oname=icon.ico" "${BUILD_RESOURCES_DIR}\icon.ico"

  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$appExe" "" "$INSTDIR\icon.ico" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"

  Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "$appExe" "" "$INSTDIR\icon.ico" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "${APP_ID}"
!macroend
