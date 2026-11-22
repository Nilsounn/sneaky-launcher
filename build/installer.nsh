; Personnalisation de l'installateur Sneaky (NSIS / MUI2)
!macro customHeader
  BrandingText "Sneaky SMP  ·  by BurningCat"
!macroend

; Mise à jour / réinstallation : on garde "sneaky-data" (jeu, mods, comptes, config).
; Seule une désinstallation manuelle (Windows > Applications) supprime tout.
!macro customRemoveFiles
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  StrCpy $R3 "0"
  ${if} ${isUpdated}
    StrCpy $R3 "1"
  ${else}
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/KEEP_APP_DATA" $R1
    ${ifNot} ${Errors}
      StrCpy $R3 "1"
    ${endIf}
  ${endIf}

  ${if} $R3 == "1"
    FindFirst $R1 $R2 "$INSTDIR\*.*"
    sneakyLoop:
      StrCmp $R2 "" sneakyDone
      StrCmp $R2 "." sneakyNext
      StrCmp $R2 ".." sneakyNext
      StrCmp $R2 "sneaky-data" sneakyNext
      IfFileExists "$INSTDIR\$R2\*.*" sneakyIsDir sneakyIsFile
      sneakyIsDir:
        RMDir /r "$INSTDIR\$R2"
        Goto sneakyNext
      sneakyIsFile:
        Delete "$INSTDIR\$R2"
      sneakyNext:
      FindNext $R1 $R2
      Goto sneakyLoop
    sneakyDone:
    FindClose $R1
  ${else}
    RMDir /r $INSTDIR
  ${endIf}

  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
