# Started by server.mjs inside its own console window. Reads the session options from the
# environment so no user text ever passes through shell quoting. OFFICE_CLAUDE is the absolute
# path of claude that the server found (git.mjs resolveExe), so no folder is searched here.
$Host.UI.RawUI.WindowTitle = $env:OFFICE_TITLE
$a = [string[]]($env:OFFICE_ARGS | ConvertFrom-Json)
& $env:OFFICE_CLAUDE @a
# The window stays open (-NoExit). A claude started in it later must not carry this session's id (#27 L7).
Remove-Item Env:OFFICE_ID -ErrorAction SilentlyContinue
