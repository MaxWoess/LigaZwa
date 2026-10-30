-- BuildScene.lua
-- Baut eine von atmogen erzeugte Szene (<szene>.reaper.lua) als Session auf, alternativ zum AAF:
-- eine Ordnerspur pro Szene, darunter eine Spur pro Bed/Layer/Event-Kategorie.
-- Die Clips sind gebacken (Gain, Pan, Tonhöhe, Fades enthalten) und klingen exakt wie die WAV.
-- Mono-Paare (L/R) liegen auf derselben Spur und sind hart links/rechts gepannt.

local r = reaper

local ok, path = r.GetUserFileNameForRead("", "atmogen-Szene wählen", "*.reaper.lua")
if not ok then return end

local chunk, err = loadfile(path)
if not chunk then
  r.MB("Datei nicht lesbar:\n" .. tostring(err), "BuildScene", 0)
  return
end
local scene = chunk()

r.Undo_BeginBlock()
r.PreventUIRefresh(1)

local base = r.CountTracks(0)
r.InsertTrackAtIndex(base, true)
local folder = r.GetTrack(0, base)
r.GetSetMediaTrackInfo_String(folder, "P_NAME", scene.name, true)
r.SetMediaTrackInfo_Value(folder, "I_FOLDERDEPTH", 1)

local last = folder
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
      r.SetMediaItemInfo_Value(item, "D_FADEINLEN", 0)
      r.SetMediaItemInfo_Value(item, "D_FADEOUTLEN", 0)
      r.SetMediaItemTakeInfo_Value(take, "D_PAN", it.pan or 0)
    end
  end
end
if last ~= folder then
  r.SetMediaTrackInfo_Value(last, "I_FOLDERDEPTH", -1)
else
  r.SetMediaTrackInfo_Value(folder, "I_FOLDERDEPTH", 0)
end

-- Loop-Bereich auf die Szenenlänge setzen, damit man den Loop direkt prüfen kann
r.GetSet_LoopTimeRange(true, true, 0, scene.length, false)

r.PreventUIRefresh(-1)
r.UpdateArrange()
r.Main_OnCommand(40047, 0) -- fehlende Peaks erzeugen
r.Undo_EndBlock("atmogen: " .. scene.name, -1)
