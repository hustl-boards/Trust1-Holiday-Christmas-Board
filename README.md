# Trust 1 Services Christmas Office TV

Static GitHub Pages slideshow for the Trust 1 Services office TV. Trust 1 Services is Plumbing, Heating and Air Conditioning, in Quincy and Hanover, Massachusetts. Twenty-four silent 15-second holiday clips play in order, each through to the end, then the loop starts over.

The page is served from `main` at the repo root:

<https://hustl-boards.github.io/Trust1-Holiday-Christmas-Board/>

One stage, a thin progress bar, hover controls, a screen wake lock, and a reload so a TV left on picks up changes. Clips live in `assets/clips/`.

## Publish on GitHub Pages

The page is a normal static site. It does not call the GitHub API.

1. Push this folder to `main`.
2. In GitHub: **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
4. Branch: **main**. Folder: **/** (root).
5. Open the Pages URL on the TV browser.

Pages can take a minute after the push. The TV may keep the previous `index.html` for about 10 minutes. The board also reloads itself every 4 hours, after the current clip finishes, so a new playlist shows up on its own.

`.nojekyll` is in the repo so Pages serves the files as they are.

## Controls

Right arrow or Space: next · Left arrow: previous · P: pause · M: sound on/off · F: fullscreen

Clips start muted so Chrome and TV browsers allow autoplay. M, or the sound button, turns sound on. The clips in this set are silent.

Hover the picture to see the controls and the clip count (`3 / 24`). The pointer hides again after a few seconds still. The countdown sits in the top-right corner, clear of the titles on the left of each clip. It ticks days, hours, minutes, and seconds until 12:00 AM Christmas morning, America/New_York, no matter what timezone the TV is set to. On December 25 it reads Merry Christmas from Trust 1 Services. After that day it counts down to the next Christmas. A light snowfall sits over the picture.

The Trust 1 Services logo is part of each clip, under the holiday headline. Logo files are `assets/trust1-logo.svg` and `assets/trust1-logo.png`.

## URL options

- `?reload=4` reloads every 4 hours (the default), after the current clip ends. About 15 minutes later the page reloads even if that clip never ends (`?hardmin=15`). `?reload=0` turns both off. The new page URL carries `?cb=` so the TV picks up a new deploy instead of a cached copy, and it resumes on the next clip.
- `?maxclip=60` is a hard cap per video, in seconds (default 60). A normal clip ends itself first.
- `?stall=8` skips a clip whose playhead has not moved for 8 seconds (the default). `error`, `stalled`, `abort`, and `emptied` skip too. Three skips in a row reload the page. One bad file does not. `?watchdog=` is an older name for the same stall window.
- `?shuffle=1` randomizes the order when the page loads.
- `?slide=3` starts on that clip (1 is the first).
- `?date=2026-12-25` previews the countdown as of 12:00 AM America/New_York at the start of that calendar day.
- `?fresh=1` loads a new page for every clip. Last resort for a TV that still leaks memory.
- `?debug=1` shows the clip name, uptime, page loads, and the last problem.

A clip that errors, stalls, or never produces a picture is skipped. The loop keeps going. If the network drops, cached clips keep playing and the board does not reload into an offline error page. When the network returns it resumes. Three failures in a row reload the page once; if that just happened, it keeps skipping instead of reboot-looping.

## Clips

The board plays these in order. `?v=` on each line in `clips.js` is the cache buster.

1. `oc01-home-alone-burst-pipe.mp4`
2. `oc02-elf-boiler-hug.mp4`
3. `oc03-christmas-vacation-furnace.mp4`
4. `oc04-jingle-all-the-way-boiler.mp4`
5. `oc05-grinch-water-heater.mp4`
6. `oc06-christmas-story-furnace.mp4`
7. `oc07-die-hard-ductwork.mp4`
8. `oc08-rudolph-heat-pump.mp4`
9. `oc09-frosty-frozen-spigot.mp4`
10. `oc10-charlie-brown-tree-radiator.mp4`
11. `oc11-nightmare-before-christmas-boiler.mp4`
12. `oc12-gremlins-leaky-pipe.mp4`
13. `oc13-polar-express-boiler.mp4`
14. `oc14-wonderful-life-radiator.mp4`
15. `oc15-santa-clause-chimney.mp4`
16. `oc16-scrooge-cold-fireplace.mp4`
17. `oc17-miracle-34th-water-heater.mp4`
18. `oc18-krampus-boiler.mp4`
19. `oc19-love-actually-cue-cards.mp4`
20. `oc20-heat-miser-boiler.mp4`
21. `oc21-christmas-chronicles-heat-pump.mp4`
22. `oc22-scrooged-frozen-thermostat.mp4`
23. `oc23-christmas-with-the-kranks-roof.mp4`
24. `oc24-jack-frost-hose-bib.mp4`

## Add or remove a clip

`clips.js` is the only playlist. The board plays that list from top to bottom. It does not scan the folder.

1. Put a 16:9 file in `assets/clips/` (MP4, WebM, or MOV). 1920×1080 is what the current clips are. Number the name (`oc25-your-title.mp4`) so the order stays obvious.
2. Add a line to `window.CLIPS` where that clip should play. To take a clip off the board, delete that line. The file can stay in the folder or go with it.
3. Commit and push to `main`.

Renaming a file does not change the order. The list does.

When you replace a file and keep the same name, change the `?v=` text on that line (any new string). That is the cache buster. Leave `?v=` alone when the bytes did not change, or the TV downloads the clip again for no reason.

`app.js`, `styles.css`, and `clips.js` are linked with `?v=20261030g`. Bump that text in `index.html` when you change those files so the TV does not keep an old copy.

## Keeping the picture moving

One `<video>` element is reused. There is no second preload element. Each clip is detached (`pause`, `src` cleared, `load()`) before the next one so the TV can free the decoder. Listeners are attached once, not per clip. Snow is a fixed 18 flakes, moved by one animation loop, and that loop pauses while the tab is hidden. The countdown is a single one-second interval. It is cleared when the page is hidden or unloaded, and started again when the picture comes back. It reads the Eastern clock on each tick, so a scheduled reload does not lose the time, and the box size stays fixed so the picture does not shift.

A screen wake lock is requested where the browser allows it, released while the page is hidden, and requested again when the page becomes visible.

A clip that errors or never produces a picture is skipped, and the loop moves on.

After the scheduled reload the page resumes on the next clip, rather than jumping back to the first one.

## Encoding

Every shipped clip is the same shape: 1920×1080, 24 fps, 15.0 seconds, H.264 High profile level 4.1, about 1.2–2.2 Mbps, faststart, plus a silent AAC track. The set is about 70 MB. Desktop Chrome plays that.

A lot of TVs only hardware-decode Baseline or Main. High profile with B-frames can stay black. If this TV does that, re-encode on a computer, put the new file in place of the old one, change `?v=`, and push:

```bash
ffmpeg -y -i "INPUT.mp4" \
  -c:v libx264 -profile:v main -level:v 4.0 -pix_fmt yuv420p \
  -r 24 -b:v 1800k -maxrate 2200k -bufsize 3600k -bf 0 \
  -an \
  -movflags +faststart \
  "OUTPUT.mp4"
```

If the picture is still black, use `-profile:v baseline -level:v 4.0 -bf 0` in place of the Main profile line.
