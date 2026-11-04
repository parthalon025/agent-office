# Started by server.mjs inside its own console window. Reads the session options from the
# environment so no user text ever passes through shell quoting. OFFICE_CLAUDE is the absolute
# path of claude that the server found (git.mjs resolveExe), so no folder is searched here.
$Host.UI.RawUI.WindowTitle = $env:OFFICE_TITLE
$a = [string[]]($env:OFFICE_ARGS | ConvertFrom-Json)
& $env:OFFICE_CLAUDE @a
