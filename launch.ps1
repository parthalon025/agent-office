# Started by server.mjs inside its own console window. Reads the session options from the
# environment so no user text ever passes through shell quoting.
$Host.UI.RawUI.WindowTitle = $env:OFFICE_TITLE
$a = [string[]]($env:OFFICE_ARGS | ConvertFrom-Json)
& claude @a
