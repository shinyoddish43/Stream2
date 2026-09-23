# From zero to streaming a run

Ten minutes, assuming the studio is already installed
([INSTALL-CPANEL.md](INSTALL-CPANEL.md)).

## 1. Bring your splits in (2 min)

**Splits → Import .lss** → pick the file you already run with.

Everything comes across: PB splits, gold segments, any extra comparisons, and
the attempt count. Nothing is rewritten on import — export it again at any
point and LiveSplit opens it.

Then **Load** the splits. The timer dock fills in, and the **Compare to**
picker lists Personal Best, Best Segments, and whatever else the file carried.

## 2. Build the scenes (1 min)

Scenes dock → **✦** → **Add them**. You get four, sized to your canvas:

| Scene | What is on it |
| --- | --- |
| Starting soon | Backdrop, your game and category, a countdown |
| Run | The speedrun timer, top-right, with room for the capture |
| Break | A reset card |
| Ending | An outro showing the final time |

## 3. Add the game (2 min)

Open the **Run** scene. Sources → **＋** → **Display / window capture**.

Pick the game window. Tick **share audio** in the browser's prompt if you want
game sound — it arrives in the mixer as its own strip.

Drag the corners to place it. Hold **Shift** to keep the aspect ratio, **Ctrl**
to place it pixel-exact. The placeholder text source can be deleted once the
capture is in.

Delete the "Game capture goes here" label, then **⤢** on the capture to fill
the canvas if you want it full-screen behind the timer.

## 4. Sound (1 min)

Mixer dock → **＋** → pick your microphone.

Set levels against the meters: speech peaking around −12 dB, game audio under
it. Click a strip name to rename it.

## 5. Hotkeys (1 min)

**Hotkeys** in the menu bar. The defaults are Numpad 1 / 3 / 8 / 2 / 5 for
split, reset, undo, skip, pause — the LiveSplit layout.

They only fire while the studio tab has focus. If you play full-screen, you
have two options:

- **⧉** in the timer dock pops the timer into its own small window; keep it on
  top and the studio behind it.
- Run LiveSplit as usual and connect the bridge — LiveSplit's global hotkeys
  then drive the timer on stream. See [`../bridge/README.md`](../bridge/README.md).

## 6. Go live (2 min)

**Destinations** → fill in Twitch (or whichever), paste the stream key, tick
it on, **Save**. Keys are encrypted on the server and never sent back.

**Settings → Output → Mode → Stream via RTMP relay**, then check the video
bitrate. On a 720p30 run, 2500 kb/s is a sensible start.

Press **Start streaming**. The pill in the corner turns red.

No relay set up yet? Use **Start recording** instead — it writes a file
straight to your computer and needs no server at all. Good for testing the
layout before anyone is watching.

## While you run

- **Start** on the timer dock, or your split hotkey, starts the run. The clock
  turns green when you are ahead, red behind, gold on a new best segment.
- The **✦ Starting soon** countdown: open its properties and press **Start**.
- Deltas follow LiveSplit's rules exactly, including dark green for "ahead but
  losing time" and orange for "behind but gaining".
- Finishing updates the PB. Resetting keeps any golds you set.
- **History** in the timer dock shows attempts, finish rate, golds, and which
  split ends the most runs.

## If the frame rate sags

In order of how much they buy you:

1. **Settings → Video → Canvas → 1280 × 720** (or 960 × 540).
2. **Frame rate → 30**, or 24 if the game itself is not smooth.
3. **Low power** in the Controls dock: half rate, no smoothing.
4. Hide sources you are not showing. Hidden costs nothing; visible costs a
   blit per frame.
5. Keep the studio tab visible. A background tab is throttled by the browser.

A still scene — the Starting soon card, say — costs almost nothing: the status
bar reads *idle* because the compositor stops repainting a picture that is not
moving. It wakes the instant something does.
