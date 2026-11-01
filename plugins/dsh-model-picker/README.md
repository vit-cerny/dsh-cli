# dsh-model-picker

Favourite models and a search field for the [DSH] composer model selector, plus
one shared favourites list that the Model Manager settings page also edits.

## What it adds

**Composer picker** (`conversation.input.model`, at priority -1 so it becomes the
rendering occupant):

- The model control you already click **is** this picker: search and favourites
  are one click away, not a second control to hunt for.
- A menu with a **search field** that filters by model name (prefix matches
  first), then by model id.
- A **star on every row**. Starred models are pinned into a `Favourites` group at
  the top of the menu, still filtered by the search field.
- Effort pills at the foot of the menu for models that expose reasoning levels,
  so a model switch can pick an effort in the same step.

The menu renders in a `document.body` portal with measured fixed positioning:
the composer card clips overflow, so a menu nested inside it would be invisible.
It opens upward by default and flips down only when there is no room above.

The trigger carries `data-efs-model-btn`, the marker `plugin-effort-slider` uses
to exclude its own button from the "hide the shipped model button" rule, so both
plugins can stay enabled.

**Model Manager settings page**: a `Favourite models` card listing every model
from every route, searchable, with the same star. Both surfaces read and write
the same list, so a star set in one appears in the other.

## State

Favourites are `provider/model` strings, capped at 500.

- Host copy (authoritative): `~/.dsh/model-picker/favorites.json`, served at
  `/api/dsh-model-picker/favorites` (loopback only, same-origin writes only).
- Browser mirror: `localStorage["dsh-model-picker.favorites.v1"]`, used when the
  Host route is unreachable, so the picker still works without the Host half.

Nothing secret is stored, and no model is ever called.

## Install

Add this folder to the `web` profile as a linked package, then restart the
profile once and refresh the page:

```powershell
dsh plugin --profile web add link:C:\Users\witek\dsh-cli\plugins\dsh-model-picker
```

Client-only edits afterwards apply on a plain page refresh.

## Tests

```powershell
cd plugins/dsh-model-picker
node --test --test-isolation=none test/smoke.mjs
```

The suite covers key normalization, the state file (including a corrupt file),
toggle semantics, and the route's auth and validation rules end to end. It also
renders the browser half under a hook runtime: the closed trigger, a favourites
notification, the opened menu (search field, one row and one star per model), and
the portaled menu's measured position.

## Layout

| File | Role |
| --- | --- |
| `lib/index.js` | Host half: the favourites file and its one HTTP route. |
| `client.js` | Browser half: the composer picker and the shared favourites store. |
| `cordis.patch.yml` | Inserts the `model-picker` row into the profile tree. |
| `test/smoke.mjs` | Host helpers, the route, and the browser render checks. |
