import { flushCharacterSaveDebounced } from '../../../../script.js';

const records = new Map();
const requestQueues = new Map();
let initialized = false;

function targetKey(target) {
    return target.draft ? target.draftExtensions : target.avatar;
}

function findCharacter(target) {
    return SillyTavern.getContext().characters.find(character => character?.avatar === target.avatar);
}

function changedFields(record) {
    return [...record.fields.values()].filter(state => state.revision > 0);
}

function dirtyFields(record) {
    return changedFields(record).filter(state => state.revision > state.savedRevision);
}

function patchFields(data, states) {
    data.extensions ??= {};
    data.extensions.alternate_fields ??= {};
    for (const state of states) {
        data.extensions.alternate_fields[state.saveKey] = structuredClone(state.entries);
    }
}

function patchJson(json, states) {
    const card = JSON.parse(json);
    if (!card?.data || typeof card.data !== 'object') throw new Error('Character metadata is unavailable.');
    patchFields(card.data, states);
    return JSON.stringify(card);
}

function ownsEditor(avatar) {
    return SillyTavern.getContext().menuType !== 'create'
        && document.getElementById('form_create')?.getAttribute('actiontype') !== 'createcharacter'
        && document.getElementById('avatar_url_pole')?.value === avatar;
}

function syncRecord(record) {
    const states = changedFields(record);
    if (!states.length) return;
    const target = record.target;
    if (target.draft) {
        if (target.draft.extensions === target.draftExtensions) patchFields(target.draft, states);
        return;
    }

    // Always resolve by avatar again: host reloads replace objects and reorder the array.
    const character = findCharacter(target);
    if (!character?.data) return;
    patchFields(character.data, states);
    if (character.json_data) character.json_data = patchJson(character.json_data, states);
    const input = document.getElementById('character_json_data');
    if (input && ownsEditor(target.avatar)) {
        const json = input.value || character.json_data;
        if (json) input.value = patchJson(json, states);
    }
}

function notify(record) {
    for (const listener of record.listeners) listener();
}

function retireSavedChanges(record) {
    if (!record || record.saving || dirtyFields(record).length || requestQueues.has(record.target.avatar)) return;
    for (const state of record.fields.values()) {
        state.revision = 0;
        state.savedRevision = 0;
    }
    if (!record.listeners.size) records.delete(targetKey(record.target));
}

function queueRequest(avatar, operation) {
    const previous = requestQueues.get(avatar) || Promise.resolve();
    const request = previous.catch(() => {}).then(operation);
    requestQueues.set(avatar, request);
    const cleanup = () => {
        if (requestQueues.get(avatar) === request) {
            requestQueues.delete(avatar);
            retireSavedChanges(records.get(avatar));
        }
    };
    void request.then(cleanup, cleanup);
    return request;
}

export function initializePersistence() {
    if (initialized) return;
    initialized = true;
    const hostFetch = globalThis.fetch.bind(globalThis);

    // The host exposes a flush, but no shared queue. Serialize only existing-card
    // form saves with our merges; both endpoints read and rewrite the whole card.
    globalThis.fetch = function (input, options) {
        if (options?.method?.toUpperCase() !== 'POST' || !(options.body instanceof FormData)) {
            return hostFetch(input, options);
        }
        let url;
        try {
            url = new URL(input instanceof Request ? input.url : input, location.href);
        } catch {
            return hostFetch(input, options);
        }
        if (url.origin !== location.origin || url.pathname !== '/api/characters/edit') {
            return hostFetch(input, options);
        }
        const avatar = options.body.get('avatar_url');
        if (typeof avatar !== 'string' || !avatar) return hostFetch(input, options);
        const body = new FormData();
        for (const [key, value] of options.body) body.append(key, value);
        return queueRequest(avatar, () => {
            const record = records.get(avatar);
            const states = record ? changedFields(record) : [];
            if (states.length) body.set('json_data', patchJson(String(body.get('json_data') || findCharacter(record.target)?.json_data), states));
            return hostFetch(input, { ...options, body });
        });
    };
}

export function getAlternateDraft(target, saveKey) {
    const state = target && records.get(targetKey(target))?.fields.get(saveKey);
    return state?.revision ? state.entries : null;
}

export function getAlternateState(target, saveKey, entries) {
    const key = targetKey(target);
    let record = records.get(key);
    if (!record) {
        record = { target, fields: new Map(), listeners: new Set(), saving: null, error: null };
        records.set(key, record);
    }
    let state = record.fields.get(saveKey);
    if (!state) {
        state = { record, saveKey, entries: structuredClone(entries), revision: 0, savedRevision: 0 };
        record.fields.set(saveKey, state);
    } else if (!state.revision) {
        state.entries = structuredClone(entries);
    }
    return state;
}

export function watchAlternateState(state, listener) {
    state.record.listeners.add(listener);
    return () => {
        state.record.listeners.delete(listener);
        retireSavedChanges(state.record);
    };
}

export function markAlternateChanged(state) {
    state.revision++;
    try {
        syncRecord(state.record);
    } catch (error) {
        state.record.error = error;
    }
    notify(state.record);
}

export function saveAlternateState(state) {
    const record = state.record;
    if (record.saving) return record.saving;
    if (!dirtyFields(record).length) return Promise.resolve(true);
    record.error = null;

    // Resolve with an explicit outcome: UI event handlers may safely fire and forget.
    record.saving = Promise.resolve().then(async () => {
        try {
            while (dirtyFields(record).length) {
                if (record.target.draft) {
                    if (record.target.draft.extensions !== record.target.draftExtensions) throw new Error('This creation draft is no longer open.');
                    syncRecord(record);
                    for (const field of dirtyFields(record)) field.savedRevision = field.revision;
                    break;
                }

                // Flushing in Create could submit the new draft. In-flight old-card
                // HTTP writes are still covered by the avatar request queue.
                if (SillyTavern.getContext().menuType !== 'create'
                    && document.getElementById('form_create')?.getAttribute('actiontype') !== 'createcharacter') {
                    await flushCharacterSaveDebounced();
                }

                await queueRequest(record.target.avatar, async () => {
                    if (!findCharacter(record.target)) throw new Error('The character is no longer available.');
                    const batch = dirtyFields(record).map(field => ({ field, revision: field.revision, entries: structuredClone(field.entries) }));
                    const alternateFields = Object.fromEntries(batch.map(item => [item.field.saveKey, item.entries]));
                    // writeExtensionField mutates the active hidden input before awaiting,
                    // and resolves on HTTP failure. Use its endpoint with a checked result.
                    const response = await fetch('/api/characters/merge-attributes', {
                        method: 'POST',
                        headers: SillyTavern.getContext().getRequestHeaders(),
                        body: JSON.stringify({ avatar: record.target.avatar, data: { extensions: { alternate_fields: alternateFields } } }),
                    });
                    if (!response.ok) throw new Error(`Alternate save failed (HTTP ${response.status}).`);
                    syncRecord(record);
                    for (const item of batch) item.field.savedRevision = item.revision;
                });
            }
            return true;
        } catch (error) {
            record.error = error;
            console.error('SillyBunny-AlternateDescriptions: alternate save failed.', error);
            globalThis.toastr?.error('Alternate changes could not be saved. Your edits are kept in this tab; reopen the manager to retry.');
            return false;
        } finally {
            record.saving = null;
            retireSavedChanges(record);
            notify(record);
        }
    });
    notify(record);
    return record.saving;
}
