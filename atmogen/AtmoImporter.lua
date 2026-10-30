-- AtmoImporter.lua
-- Importiert Audiodateien aus einem Ordner (optional mit Unterordnern) nach Filter
-- in die aktuelle REAPER-Session und kann das Ergebnis direkt als WAV rendern.
--
-- Modi:
--   1 = Layer:   jede Datei auf eigener Spur, alle ab Position 0, auf Ziellänge geloopt (Atmo-Bett)
--   2 = Sequenz: alle Dateien auf einer Spur hintereinander, mit Crossfade
--
-- Dateien ohne/mit unbekannter Endung werden per Header erkannt (OggS, RIFF, fLaC, ID3 ...)
-- und mit korrekter Endung in "<Projektordner>/AtmoImport" kopiert, damit REAPER sie lädt.
--
-- Optional: js_ReaScriptAPI (ReaPack) für einen Ordner-Auswahldialog.

local r = reaper
local SEP = package.config:sub(1, 1)
local EXT_SECTION = "AtmoImporter"

local AUDIO_EXT = { wav = true, ogg = true, mp3 = true, flac = true, aif = true, aiff = true, opus = true, m4a = true }

local function basename(p) return p:match("([^/\\]+)$") or p end

local function sniff(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local h = f:read(12) or ""
  f:close()
  if h:sub(1, 4) == "OggS" then return "ogg" end
  if h:sub(1, 4) == "RIFF" and h:sub(9, 12) == "WAVE" then return "wav" end
  if h:sub(1, 4) == "fLaC" then return "flac" end
  if h:sub(1, 4) == "FORM" then return "aiff" end
  if h:sub(1, 3) == "ID3" then return "mp3" end
  local b1, b2 = h:byte(1, 2)
  if b1 == 0xFF and b2 and b2 >= 0xE0 then return "mp3" end
  return nil
end

local function copy_file(src, dst)
  local fi = io.open(src, "rb")
  if not fi then return false end
  local fo = io.open(dst, "wb")
  if not fo then fi:close() return false end
  while true do
    local chunk = fi:read(1024 * 1024)
    if not chunk then break end
    fo:write(chunk)
  end
  fi:close()
  fo:close()
  return true
end

local function scan(dir, recursive, out)
  r.EnumerateFiles(dir, -1) -- Cache leeren (REAPER 6.20+)
  local i = 0
  while true do
    local name = r.EnumerateFiles(dir, i)
    if not name then break end
    out[#out + 1] = dir .. SEP .. name
    i = i + 1
  end
  if recursive then
    r.EnumerateSubdirectories(dir, -1)
    local j = 0
    while true do
      local sub = r.EnumerateSubdirectories(dir, j)
      if not sub then break end
      scan(dir .. SEP .. sub, true, out)
      j = j + 1
    end
  end
end

-- Liefert einen von REAPER ladbaren Pfad oder nil, wenn es keine Audiodatei ist
local function playable_path(path, cache_dir)
  local ext = (path:match("%.([%w]+)$") or ""):lower()
  if AUDIO_EXT[ext] then return path end
  local kind = sniff(path)
  if not kind then return nil end
  r.RecursiveCreateDirectory(cache_dir, 0)
  local dst = cache_dir .. SEP .. basename(path) .. "." .. kind
  if not r.file_exists(dst) and not copy_file(path, dst) then return nil end
  return dst
end

local function matches(name, terms)
  if #terms == 0 then return true end
  local lname = name:lower()
  for _, t in ipairs(terms) do
    if lname:find(t, 1, true) then return true end
  end
  return false
end

local function new_track(name)
  local idx = r.CountTracks(0)
  r.InsertTrackAtIndex(idx, true)
  local tr = r.GetTrack(0, idx)
  r.GetSetMediaTrackInfo_String(tr, "P_NAME", name, true)
  return tr
end

local function add_item(track, file, pos, len, loop, fade_in, fade_out)
  local src = r.PCM_Source_CreateFromFile(file)
  if not src then return nil end
  local srclen = r.GetMediaSourceLength(src)
  if not srclen or srclen <= 0 then return nil end
  local item = r.AddMediaItemToTrack(track)
  local take = r.AddTakeToMediaItem(item)
  r.SetMediaItemTake_Source(take, src)
  r.GetSetMediaItemTakeInfo_String(take, "P_NAME", basename(file), true)
  local L = (len and len > 0) and len or srclen
  r.SetMediaItemInfo_Value(item, "D_POSITION", pos)
  r.SetMediaItemInfo_Value(item, "D_LENGTH", L)
  r.SetMediaItemInfo_Value(item, "B_LOOPSRC", loop and 1 or 0)
  r.SetMediaItemInfo_Value(item, "D_FADEINLEN", math.min(fade_in, L / 2))
  r.SetMediaItemInfo_Value(item, "D_FADEOUTLEN", math.min(fade_out, L / 2))
  return item, L
end

---------------------------------------------------------------- Eingaben

local folder = r.GetExtState(EXT_SECTION, "folder")
if r.JS_Dialog_BrowseForFolder then
  local ok, f = r.JS_Dialog_BrowseForFolder("Quellordner wählen", folder)
  if ok ~= 1 then return end
  folder = f
end

local defaults = r.GetExtState(EXT_SECTION, "inputs")
if defaults == "" then defaults = ",1,120,2,1,0,0,atmo" end
if not r.JS_Dialog_BrowseForFolder then defaults = folder .. "," .. defaults end

local captions = "Filter (mit ; trennen, leer=alle),Modus (1=Layer 2=Sequenz),Länge Sek. (0=original),"
  .. "Fade Sek.,Unterordner (1/0),Rendern (1/0),Max. Dateien (0=alle),Render-Name,extrawidth=250"
if not r.JS_Dialog_BrowseForFolder then captions = "Quellordner," .. captions end

local ok, csv = r.GetUserInputs("Atmo Importer", r.JS_Dialog_BrowseForFolder and 8 or 9, captions, defaults)
if not ok then return end

local v = {}
for field in (csv .. ","):gmatch("([^,]*),") do v[#v + 1] = field end
if not r.JS_Dialog_BrowseForFolder then folder = table.remove(v, 1) end
r.SetExtState(EXT_SECTION, "inputs", table.concat(v, ","), true)
r.SetExtState(EXT_SECTION, "folder", folder, true)

local terms = {}
for raw in (v[1] or ""):gmatch("[^;]+") do
  local t = raw:match("^%s*(.-)%s*$"):lower()
  if t ~= "" then terms[#terms + 1] = t end
end
local mode      = tonumber(v[2]) or 1
local length    = tonumber(v[3]) or 0
local fade      = tonumber(v[4]) or 0
local recursive = v[5] == "1"
local do_render = v[6] == "1"
local max_files = tonumber(v[7]) or 0
local out_name  = (v[8] ~= nil and v[8] ~= "") and v[8] or "atmo"

folder = folder:gsub("[/\\]+$", "")
if folder == "" then
  r.MB("Kein Ordner angegeben.", "Atmo Importer", 0)
  return
end

---------------------------------------------------------------- Dateien sammeln

local cache_dir = r.GetProjectPath("") .. SEP .. "AtmoImport"
local all = {}
scan(folder, recursive, all)
table.sort(all)

local files = {}
for _, p in ipairs(all) do
  if matches(p:sub(#folder + 2), terms) then
    local pp = playable_path(p, cache_dir)
    if pp then files[#files + 1] = pp end
    if max_files > 0 and #files >= max_files then break end
  end
end

if #files == 0 then
  r.MB("Keine passenden Audiodateien gefunden.", "Atmo Importer", 0)
  return
end

---------------------------------------------------------------- Import

r.Undo_BeginBlock()
r.PreventUIRefresh(1)

if mode == 2 then
  local tr = new_track("Sequenz: " .. out_name)
  local pos = 0
  for _, f in ipairs(files) do
    local item, L = add_item(tr, f, pos, length, length > 0, fade, fade)
    if item then pos = pos + L - fade end
  end
else
  for _, f in ipairs(files) do
    local tr = new_track(basename(f))
    add_item(tr, f, 0, length, true, fade, fade)
  end
end

r.PreventUIRefresh(-1)
r.UpdateArrange()
r.Main_OnCommand(40047, 0) -- Peaks: fehlende Peaks erzeugen
r.Undo_EndBlock("Atmo Importer: " .. #files .. " Dateien", -1)

---------------------------------------------------------------- Render

if do_render then
  -- Format (WAV, Bittiefe, Samplerate) kommt aus den zuletzt im Render-Dialog
  -- verwendeten Einstellungen; hier nur Bereich, Zielordner und Dateiname setzen.
  r.GetSetProjectInfo(0, "RENDER_BOUNDSFLAG", 1, true) -- gesamtes Projekt
  r.GetSetProjectInfo_String(0, "RENDER_FILE", r.GetProjectPath("") .. SEP .. "Renders", true)
  r.GetSetProjectInfo_String(0, "RENDER_PATTERN", out_name, true)
  r.Main_OnCommand(42230, 0) -- Rendern mit letzten Einstellungen, Dialog automatisch schließen
end
