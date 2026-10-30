-- BuildScene.lua
-- Baut eine von atmogen.py erzeugte Szene (<szene>.reaper.lua) als editierbare Session auf:
-- eine Spur pro Bed/Layer und pro Event-Kategorie, jedes Event als eigenes Item mit Pan, Gain und Rate.
-- Ergebnis entspricht der gerenderten WAV (bis auf die Loop-Nähte, die REAPER ohne Crossfade loopt).

local r = reaper

local ok, path = r.GetUserFileNameForRead("", "atmogen-Szene wählen", "*.reaper.lua")
if not ok then return end

local chunk, err = loadfile(path)
if not chunk then
  r.MB("Datei nicht lesbar:\n" .. tostring(err), "BuildScene", 0)
  return
end
local scene = chunk()

local function db2lin(d) return 10 ^ (d / 20) end

r.Undo_BeginBlock()
r.PreventUIRefresh(1)

-- Ordnerspur für die Szene
local base = r.CountTracks(0)
r.InsertTrackAtIndex(base, true)
local folder = r.GetTrack(0, base)
r.GetSetMediaTrackInfo_String(folder, "P_NAME", scene.name, true)
r.SetMediaTrackInfo_Value(folder, "I_FOLDERDEPTH", 1)
r.SetMediaTrackInfo_Value(folder, "D_VOL", db2lin(scene.master_gain_db or 0))

local last
for _, t in ipairs(scene.tracks) do
  local idx = r.CountTracks(0)
  r.InsertTrackAtIndex(idx, true)
  local tr = r.GetTrack(0, idx)
  r.GetSetMediaTrackInfo_String(tr, "P_NAME", t.name, true)
  last = tr

  for _, it in ipairs(t.items) do
    local src = r.PCM_Source_CreateFromFile(it.file)
    if src then
      local item = r.AddMediaItemToTrack(tr)
      local take = r.AddTakeToMediaItem(item)
      r.SetMediaItemTake_Source(take, src)
      r.GetSetMediaItemTakeInfo_String(take, "P_NAME", it.file:match("([^/\\]+)$") or it.file, true)
      r.SetMediaItemInfo_Value(item, "D_POSITION", it.pos)
      r.SetMediaItemInfo_Value(item, "D_LENGTH", it.len)
      r.SetMediaItemInfo_Value(item, "B_LOOPSRC", it.loop and 1 or 0)
      r.SetMediaItemInfo_Value(item, "D_VOL", db2lin(it.gain_db))
      r.SetMediaItemInfo_Value(item, "D_FADEINLEN", it.loop and it.fade or 0)
      r.SetMediaItemInfo_Value(item, "D_FADEOUTLEN", it.fade)
      r.SetMediaItemTakeInfo_Value(take, "D_STARTOFFS", it.offs)
      r.SetMediaItemTakeInfo_Value(take, "D_PLAYRATE", it.rate)
      r.SetMediaItemTakeInfo_Value(take, "B_PPITCH", 0) -- Rate ändert auch die Tonhöhe, wie im Render
      r.SetMediaItemTakeInfo_Value(take, "D_PAN", it.pan)
    end
  end
end
if last then r.SetMediaTrackInfo_Value(last, "I_FOLDERDEPTH", -1) end

r.PreventUIRefresh(-1)
r.UpdateArrange()
r.Main_OnCommand(40047, 0) -- fehlende Peaks erzeugen
r.Undo_EndBlock("atmogen: " .. scene.name, -1)
