# SillyBunny-AlternateDescriptions

Keep multiple versions of a character's fields in one card and switch between them in SillyBunny.

This is a fork of [Nbrown725's SillyTavern-AlternateDescriptions](https://github.com/nbrown725/SillyTavern-AlternateDescriptions), documented upstream as **SillyTavern Alternate Fields**. It keeps the original six fields, named alternates, token counts, and `/altfield` command, with chang@James to the editor and saving behavior for SillyBunny.

Supported fields: **Description, Personality, Scenario, Example Dialogue, Main Prompt, and Post-History Instructions**.

## Changes from upstream

### Compatibility patches

- Replaced the popup with an inline manager beneath each field. Only one manager is open at a time; closing it returns focus to its button.
- Updated button placement for SillyBunny's character editor, with fallback placement when an expected anchor is missing. Buttons are restored when editor fields are rebuilt, without adding duplicates.
- Kept the existing `alternate_fields` storage format. Older `alternate_descriptions` data can be converted without removing its source; existing modern lists, including intentionally empty ones, take precedence.
- Added native keyboard controls, visible focus indicators, theme-aware styling, and layouts that accommodate narrow screens and enlarged text. Enter activates buttons once and does not submit the character form from an alternate title; Escape closes the manager.

### Bug fixes

- Coordinated alternate saves with SillyBunny's character autosave so overlapping writes do not discard alternate edits, main-field edits, or unrelated card metadata.
- Bound pending edits to the original character or creation draft. Switching characters, reordering the character list, or viewing a group member no longer redirects delayed writes into another editor or a new-character draft.
- Added checked save responses, visible saving and failure states, and **Retry Save**. Failed edits remain available when the manager is closed and reopened in the same tab.
- Each field manager now has its own save timer and saves pending edits when it closes. Deleted entries are not restored by stale timers, and completed saves no longer overwrite subsequently refreshed alternates.
- Escaped character names, alternate titles, and autocomplete previews, and inserted alternate content as text. Imported HTML is displayed literally in these surfaces.
- Prevented older token-count responses from replacing newer counts and added a fallback when counting fails.

## Installation

1. Open SillyBunny and go to **Extensions → Install extension**.
2. Enter this repository URL: `https://github.com/voldomero/SillyBunny-AlternateDescriptions`.
3. Download the extension, then open a character's editor. An **Alt. [Field]** button appears beside each supported field.

## Usage and saving

1. Click a field's **Alt.** button to open its manager. If there are no alternates and the field has content, that content is saved as the first alternate.
2. Use **Add New** to copy the current editor content into another alternate. Edit its title and content in the manager; those edits save automatically after a short pause.
3. Click **Use** to put an alternate into the character field. Editing a saved alternate does not apply it to the active field until you click **Use**.
4. If you change the main character field directly, use **Save Current** to keep that text as another alternate before switching. **Use** asks for confirmation when the current non-empty text does not match a saved version.

The save status reports whether changes are saving, saved, or kept in a creation draft. A creation draft becomes a saved card only when you create the character. If saving fails, use **Retry Save** before refreshing or closing the browser tab; the retained edits are only in that tab's memory.

### Slash command

```text
/altfield field=description name="description #1"
/altfield field="example dialogue" name="First meeting"
/altfield field=scenario
```

`field` is required. Its values are `description`, `personality`, `scenario`, `example dialogue`, `main prompt`, and `post-history instructions`. Quote values that contain spaces. `name` must match a saved title exactly; omit it to choose a random alternate. Field names offer autocomplete; alternate names do too once a field is selected.

The command replaces the current field without a confirmation or a backup of its text. Save any version you want to keep first.

## Card data

Alternates stay in the card at `data.extensions.alternate_fields`, using the same field keys as upstream, so they travel with the exported card. Legacy `alternate_descriptions` data is preserved during conversion: deleting a converted alternate does not erase its legacy copy.

## Credits

Original extension by [**Nbrown725**](https://github.com/nbrown725/SillyTavern-AlternateDescriptions); SillyBunny adaptation by **voldomero**.
