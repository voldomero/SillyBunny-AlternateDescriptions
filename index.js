/*
 * SillyBunny-AlternateDescriptions, adapted from Nbrown725's SillyTavern extension
 * Based on patterns from Group Greetings extension
 * Licensed under AGPLv3
 */

import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { ARGUMENT_TYPE, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue, enumTypes } from '../../../slash-commands/SlashCommandEnumValue.js';
import { getAlternateDraft, getAlternateState, initializePersistence, markAlternateChanged, saveAlternateState, watchAlternateState } from './persistence.js';

const fieldConfigs = [
    {
        field: 'description',
        button_name: 'Descriptions',
        selector: '#description_div',
        inject_point: '.editor_maximize[data-for="description_textarea"]',
        textarea: 'description_textarea',
        saveKey: 'alt_descriptions',
    },
    {
        field: 'personality',
        button_name: 'Personalities',
        selector: '#personality_div',
        inject_point: '.notes-link',
        textarea: 'personality_textarea',
        saveKey: 'alt_personalities',
    },
    {
        field: 'scenario',
        button_name: 'Scenarios',
        selector: '#scenario_div',
        inject_point: '.notes-link',
        textarea: 'scenario_pole',
        saveKey: 'alt_scenarios',
    },
    {
        field: 'example dialogue',
        button_name: 'Example Dialogue',
        selector: '#mes_example_div',
        inject_point: '.editor_maximize',
        textarea: 'mes_example_textarea',
        saveKey: 'alt_example_dialogue',
    },
    {
        field: 'main prompt',
        button_name: 'Main Prompts',
        selector: '#system_prompt_textarea',
        inject_point: '.editor_maximize',
        textarea: 'system_prompt_textarea',
        saveKey: 'alt_main_prompts',
    },
    {
        field: 'post-history instructions',
        button_name: 'Post-History Instructions',
        selector: '#post_history_instructions_textarea',
        inject_point: '.editor_maximize',
        textarea: 'post_history_instructions_textarea',
        saveKey: 'alt_post_history',
    },
];

// Utility functions for handling character context
class ContextUtil {
    static getCharacterId() {
        const context = SillyTavern.getContext();
        let characterId = context.characterId;
        // When peeking a group chat member, find a proper characterId
        if (context.groupId) {
            const avatarUrlInput = document.getElementById('avatar_url_pole');
            if (avatarUrlInput instanceof HTMLInputElement) {
                const avatarUrl = avatarUrlInput.value;
                characterId = context.characters.findIndex(c => c.avatar === avatarUrl);
            }
        }
        return characterId;
    }

    static captureTarget() {
        const context = SillyTavern.getContext();
        if (context.menuType === 'create') {
            const draft = context.createCharacterData;
            return { draft, draftExtensions: draft.extensions ??= {} };
        }
        const character = context.characters[ContextUtil.getCharacterId()];
        return character?.avatar ? { avatar: character.avatar } : null;
    }

    static getData(target) {
        if (!target) return null;
        if (target?.draft) {
            return target.draft.extensions === target.draftExtensions ? target.draft : null;
        }
        return SillyTavern.getContext().characters.find(c => c.avatar === target?.avatar)?.data;
    }

    static isCurrent(target) {
        const current = ContextUtil.captureTarget();
        if (!target || !current) return false;
        if (target.draft) return target.draft === current.draft && target.draftExtensions === current.draftExtensions;
        if (target.avatar !== current.avatar) return false;
        const editorAvatar = document.getElementById('avatar_url_pole')?.value;
        return !editorAvatar || editorAvatar === target.avatar;
    }

    static getName(field) {
        return ContextUtil.getData(field.target)?.name || 'Unknown';
    }

    static getFieldData(field) {
        const target = field.target || ContextUtil.captureTarget();
        const pending = getAlternateDraft(target, field.saveKey);
        if (pending) return pending;
        const extensions = ContextUtil.getData(target)?.extensions;
        const saved = extensions?.alternate_fields?.[field.saveKey];
        if (Array.isArray(saved)) {
            return saved.filter(entry => entry && typeof entry.title === 'string' && typeof entry.content === 'string');
        }
        const legacy = extensions?.alternate_descriptions;
        if (field.saveKey !== 'alt_descriptions' || !Array.isArray(legacy)) return [];

        // Keep the legacy source intact; only save the converted copy when the manager is opened.
        return legacy.flatMap((entry, index) => {
            if (typeof entry === 'string') return [{ title: `Description #${index + 1}`, content: entry }];
            const content = entry?.content ?? entry?.description;
            return typeof content === 'string'
                ? [{ ...entry, title: typeof entry.title === 'string' ? entry.title : `Description #${index + 1}`, content }]
                : [];
        });
    }

    static getCurrentField(field) {
        if (!ContextUtil.isCurrent(field.target || ContextUtil.captureTarget())) return '';
        return document.getElementById(field.textarea)?.value || '';
    }

    static setCurrentField(field, entry) {
        if (!ContextUtil.isCurrent(field.target || ContextUtil.captureTarget())) {
            throw new Error('Must have a character selected.');
        }
        const textarea = document.getElementById(field.textarea);
        if (!textarea) throw new Error('Character field is unavailable.');
        textarea.value = entry;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
}

function reportError(error) {
    console.error('SillyBunny-AlternateDescriptions:', error);
    globalThis.toastr?.error(error.message);
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
    })[character]);
}

// Check if current description matches any saved descriptions
function checkFieldStatus(container, field, fieldData) {
    const currentFieldEntry = ContextUtil.getCurrentField(field);
    const hasMatch = fieldData.some(entry => entry.content.trim() === currentFieldEntry.trim());

    // Find or create status indicator
    let statusIndicator = container.querySelector('#field-status');
    if (!statusIndicator) {
        statusIndicator = document.createElement('div');
        statusIndicator.id = 'field-status';
        statusIndicator.className = 'alt-field-status';
        statusIndicator.setAttribute('role', 'status');

        // Insert after the instructions
        const hr = container.querySelectorAll('hr')[1];
        hr.parentNode.insertBefore(statusIndicator, hr.nextSibling);
    }

    statusIndicator.hidden = false;
    if (!hasMatch && currentFieldEntry.trim()) {
        // Current description has been edited
        statusIndicator.classList.add('alt-field-modified');
        statusIndicator.innerHTML = `
            <i class="fa-solid fa-exclamation-triangle"></i>
            <span>Current ${field.field} has been modified and doesn't match any saved version.</span>
            <button type="button" class="menu_button menu_button_icon" id="save-current-btn">
                <i class="fa-solid fa-save"></i>
                <span>Save Current</span>
            </button>
        `;

        // Add click handler for the save button
        statusIndicator.querySelector('#save-current-btn').addEventListener('click', () => {
            fieldData.push({ title: `${field.field} #${fieldData.length + 1}`, content: currentFieldEntry });
            saveManagerData(container);
            updateFieldList(container, field, fieldData);
            checkFieldStatus(container, field, fieldData);
            container.querySelector('.field-item:last-child .field-title')?.focus();
        });
    } else if (hasMatch) {
        // Current description matches a saved version
        statusIndicator.classList.remove('alt-field-modified');
        statusIndicator.innerHTML = `
            <i class="fa-solid fa-check-circle"></i>
            <span>Current ${field.field} matches a saved version.</span>
        `;
    } else {
        // No current description
        statusIndicator.hidden = true;
    }
}

// Smart update of active indicators without re-rendering entire list
function updateActiveIndicators(container, field, fieldData) {
    const currentFieldEntry = ContextUtil.getCurrentField(field);
    const listContainer = container.querySelector('#field-list');

    fieldData.forEach((entry, index) => {
        const isActive = entry.content.trim() === currentFieldEntry.trim();
        const entryItem = listContainer.querySelector(`[data-item-index="${index}"]`);

        if (entryItem) {
            const activeIndicator = entryItem.querySelector('.active-indicator');
            const useBtn = entryItem.querySelector('.use-field-btn');

            // Update active class and styling
            if (isActive) {
                entryItem.classList.add('active-field');
                useBtn.style.opacity = '0.5';
                useBtn.title = 'Already active';
                activeIndicator.innerHTML = '<i class="fa-solid fa-check-circle" aria-label="Already active"></i>';
            } else {
                entryItem.classList.remove('active-field');
                useBtn.style.opacity = '';
                useBtn.title = '';
                activeIndicator.innerHTML = '';
            }
        }
    });

    // Update the status indicator
    checkFieldStatus(container, field, fieldData);
}

const managerStates = new WeakMap();
let activeManager = null;

function preserveNativeActivation(event) {
    if (event.key === 'Enter' && event.target instanceof HTMLButtonElement) {
        // The host synthesizes another click for .menu_button on document keydown.
        event.stopPropagation();
    }
}

function closeManager(restoreFocus = true) {
    if (!activeManager) return;
    const { container, trigger, field } = activeManager;
    activeManager = null;
    managerStates.get(container).dispose();
    container.remove();
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-controls');
    if (restoreFocus && trigger.isConnected && ContextUtil.isCurrent(field.target)) {
        trigger.focus();
    }
}

function saveManagerData(container, changed = true) {
    const state = managerStates.get(container);
    clearTimeout(state.saveTimer);
    if (changed) markAlternateChanged(state.saveState);
    return saveAlternateState(state.saveState);
}

function scheduleManagerSave(container) {
    const state = managerStates.get(container);
    clearTimeout(state.saveTimer);
    markAlternateChanged(state.saveState);
    state.saveTimer = setTimeout(() => saveManagerData(container, false), 500);
}

function updateSaveStatus(container) {
    const { saveState } = managerStates.get(container);
    const status = container.querySelector('.alt-save-status');
    const retry = container.querySelector('.alt-retry-save');
    const { record } = saveState;
    const dirty = saveState.revision > saveState.savedRevision;
    status.textContent = record.error ? 'Save failed. Your edits are kept in this tab.'
        : record.saving ? 'Saving…' : dirty ? 'Unsaved changes'
            : record.target.draft ? 'Kept in this creation draft' : 'Saved';
    retry.hidden = !record.error;
    retry.disabled = Boolean(record.saving);
}

async function updateTokenCount(display, content) {
    const revision = Symbol();
    display.tokenRevision = revision;
    try {
        const count = await SillyTavern.getContext().getTokenCountAsync(content);
        if (display.tokenRevision === revision) display.textContent = count;
    } catch {
        if (display.tokenRevision === revision) display.textContent = '—';
    }
}

function updateFieldList(container, field, fieldData) {
    const listContainer = container.querySelector('#field-list');
    const currentFieldEntry = ContextUtil.getCurrentField(field);
    const state = managerStates.get(container);
    state.tokenTimers.forEach(clearTimeout);
    state.tokenTimers.clear();

    if (fieldData.length === 0) {
        listContainer.innerHTML = `<strong>Click <i class="fa-solid fa-plus"></i> to save the current ${field.field}</strong>`;
        checkFieldStatus(container, field, fieldData);
        return;
    }

    listContainer.innerHTML = fieldData.map((entry, index) => {
        const isActive = entry.content.trim() === currentFieldEntry.trim();
        const activeClass = isActive ? 'active-field' : '';
        const activeIndicator = isActive ? '<i class="fa-solid fa-check-circle" aria-label="Already active"></i>' : '';

        return `
            <div class="field-item ${activeClass}" data-item-index="${index}">
                <div class="flex-container justifySpaceBetween alt-field-row">
                    <div class="flex-container alt-field-title-row">
                        <input class="text_pole textarea_compact field-title margin0" data-index="${index}" value="${escapeHtml(entry.title)}" placeholder="${field.field} title" aria-label="${field.field} title" maxlength="50">
                        <div class="active-indicator">${activeIndicator}</div>
                    </div>
                    <div class="flex-container alt-field-actions">
                        <button type="button" class="menu_button menu_button_icon use-field-btn" data-index="${index}" ${isActive ? 'style="opacity: 0.5;" title="Already active"' : ''}>
                            <i class="fa-solid fa-arrow-up"></i>
                            <span>Use</span>
                        </button>
                        <button type="button" class="menu_button menu_button_icon delete-field-btn" data-index="${index}">
                            <i class="fa-solid fa-trash"></i>
                            <span>Delete</span>
                        </button>
                    </div>
                </div>
                <textarea class="text_pole textarea_compact field-textarea" rows="8" data-index="${index}" placeholder="${field.field}..." aria-label="${field.field}"></textarea>
                <div class="extension_token_counter" style="text-align: right; margin-top: 5px;">
                    <span>Tokens:</span> <span data-token-display="${index}">calculating...</span>
                </div>
            </div>
        `;
    }).join('');

    // Calculate initial token counts
    fieldData.forEach((entry, index) => {
        listContainer.querySelector(`.field-textarea[data-index="${index}"]`).value = entry.content;
        void updateTokenCount(container.querySelector(`[data-token-display="${index}"]`), entry.content);
    });

    // Add event listeners
    listContainer.querySelectorAll('.use-field-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            if (!ContextUtil.isCurrent(field.target)) {
                reportError(new Error('Must have a character selected.'));
                return;
            }
            const index = parseInt(e.currentTarget.dataset.index);
            const currentFieldEntry = ContextUtil.getCurrentField(field);
            const hasUnsavedChanges = !fieldData.some(entry => entry.content.trim() === currentFieldEntry.trim()) && currentFieldEntry.trim();

            if (hasUnsavedChanges) {
                // Show simple confirmation dialog
                const confirmed = confirm(`Your current ${field.field} has unsaved changes. Switch to this ${field.field} anyway?`);

                if (confirmed) {
                    ContextUtil.setCurrentField(field, fieldData[index].content);
                    updateActiveIndicators(container, field, fieldData);
                }
                // If not confirmed, do nothing
            } else {
                // No unsaved changes, switch directly
                ContextUtil.setCurrentField(field, fieldData[index].content);
                updateActiveIndicators(container, field, fieldData);
            }
        });
    });

    listContainer.querySelectorAll('.delete-field-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = parseInt(e.currentTarget.dataset.index);

            // Show confirmation dialog before deleting
            const confirmed = confirm(`Are you sure you want to delete ${fieldData[index].title}? This action cannot be undone.`);

            if (confirmed) {
                fieldData.splice(index, 1);
                saveManagerData(container);
                updateFieldList(container, field, fieldData);
                const next = container.querySelectorAll('.delete-field-btn')[Math.min(index, fieldData.length - 1)]
                    || container.querySelector('#add-field-btn');
                next.focus();
            }
            // If not confirmed, do nothing
        });
    });

    listContainer.querySelectorAll('.field-textarea').forEach(textarea => {
        textarea.addEventListener('input', (e) => {
            const index = parseInt(e.target.dataset.index);
            fieldData[index].content = e.target.value;
            updateActiveIndicators(container, field, fieldData);
            scheduleManagerSave(container);
            const display = container.querySelector(`[data-token-display="${index}"]`);
            display.tokenRevision = null;
            clearTimeout(textarea.tokenTimer);
            state.tokenTimers.delete(textarea.tokenTimer);
            textarea.tokenTimer = setTimeout(() => {
                state.tokenTimers.delete(textarea.tokenTimer);
                void updateTokenCount(display, textarea.value);
            }, 500);
            state.tokenTimers.add(textarea.tokenTimer);
        });
    });

    listContainer.querySelectorAll('.field-title').forEach(titleInput => {
        titleInput.addEventListener('input', (e) => {
            const index = parseInt(e.target.dataset.index);
            fieldData[index].title = e.target.value;

            scheduleManagerSave(container);
        });
    });
    checkFieldStatus(container, field, fieldData);
}

// Monitor the main description textarea for changes
function setupFieldMonitoring(container, field, fieldData) {
    const mainTextarea = document.getElementById(field.textarea);
    const state = managerStates.get(container);
    const checkStatus = () => updateActiveIndicators(container, field, fieldData);
    mainTextarea?.addEventListener('input', checkStatus);
    state.dispose = () => {
        if (state.closed) return;
        state.closed = true;
        mainTextarea?.removeEventListener('input', checkStatus);
        state.tokenTimers.forEach(clearTimeout);
        clearTimeout(state.saveTimer);
        state.unsubscribe();
        if (state.saveState.revision > state.saveState.savedRevision && !state.saveState.record.error) {
            void saveManagerData(container, false);
        }
        observer.disconnect();
    };
    let mounted = false;
    const observer = new MutationObserver(() => {
        if (container.isConnected) mounted = true;
        else if (mounted) state.dispose();
        if (activeManager?.container === container && (!container.isConnected || !ContextUtil.isCurrent(field.target)
            || mainTextarea?.closest('[hidden], [aria-hidden="true"]'))) closeManager(false);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'actiontype', 'data-menu-type'] });
}

function createManagerContent(field) {
    const characterName = ContextUtil.getName(field);
    let fieldData = ContextUtil.getFieldData(field);
    let currentFieldEntry = ContextUtil.getCurrentField(field);
    let needsSave = false;

    // AUTO-SAVE: If this is the first time opening and there's a current description
    if (fieldData.length === 0 && currentFieldEntry.trim()) {
        fieldData = [{ title: `${field.field} #1`, content: currentFieldEntry }];
        needsSave = true;
    } else if (fieldData.length && !ContextUtil.getData(field.target)?.extensions?.alternate_fields?.[field.saveKey]) {
        needsSave = true;
    }

    const container = document.createElement('div');
    container.id = `alt-manager-${field.saveKey}`;
    container.className = 'alt-fields-manager flex-container flexFlowColumn';
    container.setAttribute('role', 'region');
    container.setAttribute('aria-labelledby', `${container.id}-title`);
    const saveState = getAlternateState(field.target, field.saveKey, fieldData);
    fieldData = saveState.entries;
    managerStates.set(container, { saveState, saveTimer: null, tokenTimers: new Set(), closed: false });

    container.innerHTML = `
        <div class="alt-manager-header">
            <h3 class="margin0" id="${container.id}-title" tabindex="-1">Alternate ${field.button_name} for <span>${escapeHtml(characterName)}</span></h3>
            <div class="alt-manager-controls">
                <button type="button" id="add-field-btn" class="menu_button menu_button_icon">
                    <i class="fa-solid fa-plus" aria-hidden="true"></i>
                    <span>Add New</span>
                </button>
                <button type="button" class="menu_button alt-close-manager">Close</button>
            </div>
        </div>
        <hr>
        <div class="justifyLeft">
            <small>
                Save different versions of your character's ${field.field}. Click "Use" to switch the active ${field.field} in the editor.
                ${fieldData.length === 1 && fieldData[0].content === currentFieldEntry ? `<br><strong>Your original ${field.field} is included below.</strong>` : ''}
            </small>
        </div>
        <hr>
        <div class="alt-save-feedback">
            <span class="alt-save-status" role="status" aria-live="polite"></span>
            <button type="button" class="menu_button alt-retry-save" hidden>Retry Save</button>
        </div>
        <div id="field-list"></div>
    `;

    container.addEventListener('keydown', event => {
        preserveNativeActivation(event);
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement && !event.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            void saveManagerData(container, false);
        }
        if (event.key === 'Escape' && !event.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            closeManager();
        }
    });
    container.querySelector('.alt-close-manager').addEventListener('click', () => closeManager());

    managerStates.get(container).unsubscribe = watchAlternateState(saveState, () => updateSaveStatus(container));
    container.querySelector('.alt-retry-save').addEventListener('click', () => { void saveAlternateState(saveState); });
    updateSaveStatus(container);
    if (needsSave && !saveState.revision) void saveManagerData(container);

    container.querySelector('#add-field-btn').addEventListener('click', () => {
        currentFieldEntry = ContextUtil.getCurrentField(field);
        fieldData.push({ title: `${field.field} #${fieldData.length + 1}`, content: currentFieldEntry });
        saveManagerData(container);
        updateFieldList(container, field, fieldData);
    });

    // Initial render
    updateFieldList(container, field, fieldData);

    // Setup real-time monitoring of main textarea
    setupFieldMonitoring(container, field, fieldData);

    return container;
}

// Create field button
function createButton(field) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button menu_button_icon alt_${field.saveKey}_button alt_fields_button`;
    button.title = `Manage alternate ${field.field}s`;
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = `<i class="fa-solid fa-bars-staggered"></i><span>Alt. ${field.button_name}</span>`;

    button.addEventListener('keydown', preserveNativeActivation);
    button.addEventListener('click', () => {
        try {
            if (activeManager?.trigger === button) {
                closeManager();
                return;
            }
            const target = ContextUtil.captureTarget();
            if (!ContextUtil.isCurrent(target)) throw new Error('Must have a character selected.');
            closeManager(false);
            const managerField = { ...field, target };
            const container = createManagerContent(managerField);
            const textarea = document.getElementById(field.textarea);
            textarea.after(container);
            activeManager = { container, trigger: button, field: managerField };
            button.setAttribute('aria-expanded', 'true');
            button.setAttribute('aria-controls', container.id);
            const heading = container.querySelector('h3');
            heading.focus({ preventScroll: true });
            container.scrollIntoView({ block: 'start', inline: 'nearest' });
        } catch (error) {
            reportError(error);
        }
    });

    return button;
}

// Inject buttons into the field area
function injectButtons() {
    fieldConfigs.forEach(field => {
        const textarea = document.getElementById(field.textarea);
        if (!textarea) return;
        const root = document.querySelector(field.selector);
        const area = root?.matches('textarea') ? root.closest('div') : root;
        const anchor = area?.querySelector(field.inject_point);
        const parent = anchor?.parentElement || textarea.parentElement;
        if (!parent || parent.querySelector(`.alt_${field.saveKey}_button`)) return;
        const button = createButton(field);
        if (anchor) anchor.after(button);
        else textarea.before(button);
    });
}

function initializeButtons() {
    injectButtons();
    const context = SillyTavern.getContext();
    const events = context.eventTypes || context.event_types;
    if (events?.CHARACTER_EDITOR_OPENED) context.eventSource?.on(events.CHARACTER_EDITOR_OPENED, () => {
        if (activeManager && !ContextUtil.isCurrent(activeManager.field.target)) closeManager(false);
    });
    for (const name of ['APP_READY', 'CHARACTER_EDITOR_OPENED', 'CHARACTER_PAGE_LOADED']) {
        if (events?.[name]) context.eventSource?.on(events[name], injectButtons);
    }
    const selector = fieldConfigs.map(field => `#${field.textarea}`).join(',');
    const observer = new MutationObserver(mutations => {
        if (mutations.some(mutation => [...mutation.addedNodes].some(node =>
            node.nodeType === Node.ELEMENT_NODE && (node.matches(selector) || node.querySelector(selector)),
        ))) injectButtons();
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

// Register slash command to switch field entry
function registerSlashCommand() {
    // Enum provider for field types
    const fieldEnumProvider = () => {
        return fieldConfigs.map(field =>
            new SlashCommandEnumValue(
                field.field, // field name
                field.button_name, // field name plural
                enumTypes.name, // field type
            ),
        );
    };

    // Enum provider for field names
    const fieldNameEnumProvider = (executor) => {
        // Get the current value of the field argument
        const fieldValue = executor.namedArgumentList.find(x => x.name === 'field')?.value;

        // return empty if no field is specified
        if (!fieldValue) {
            return []; // No field specified yet
        }

        // Get field config for fieldValue. Return empty if fieldConfig cannot be found
        const fieldConfig = fieldConfigs.find(f => f.field === fieldValue);
        if (!fieldConfig) {
            return []; // Invalid field
        }

        // Get the field data
        const fieldData = ContextUtil.getFieldData(fieldConfig);

        // Return enum values for each alternate entry
        return fieldData.map(entry =>
            new SlashCommandEnumValue(
                entry.title, // field name
                escapeHtml(entry.content.substring(0, 50) + (entry.content.length > 50 ? '...' : '')), // The host parses previews as HTML.
                enumTypes.name, // field type
            ),
        );
    };

    // Register the slash command
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'altfield',
        callback: altFieldCallback,
        helpString: `
        <div>
        Switch to an alternate field entry. Must have a character selected.
        </div>
        <div>
        <strong>WARNING:</strong> Will overwrite current field without saving it.
        </div>
        <div>
            <strong>Example:</strong>
            <ul>
                <li>
                    <pre><code>/altfield field=description name="Description #1"</code></pre>
                    Changes the description field to the alternate entry titled "Description #1"
                </li>
            </ul>
        </div>`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'field',
                description: 'Field type to switch (description, personality, etc.)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: fieldEnumProvider,
                forceEnum: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'The name of the saved alternate to switch to',
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: fieldNameEnumProvider,
            }),
        ],
        returns: ARGUMENT_TYPE.STRING,
    }));
}

// Callback function that executes the command
function altFieldCallback(namedArguments) {
    const { field, name } = namedArguments;

    try {
        // Get field config for field arg. Return error if field is invalid.
        const config = fieldConfigs.find(f => f.field === field);
        if (!config) {
            return `Error: Unknown field "${field}". Available fields: ${fieldConfigs.map(f => f.field).join(', ')}`;
        }

        const target = ContextUtil.captureTarget();
        if (!ContextUtil.isCurrent(target)) return 'Error: Must have a character selected.';
        const fieldConfig = { ...config, target };

        // Get the field data. Return empty string if no entries found
        const fieldData = ContextUtil.getFieldData(fieldConfig);

        if (fieldData.length === 0) {
            return `Error: No field entries found for ${field}`;
        }

        let alternate;

        // If name is provided, find the specific alternate. Else return random
        if (name && name.trim()) {
            alternate = fieldData.find(entry => entry.title === name);
            if (!alternate) {
                const availableNames = fieldData.map(entry => entry.title);
                return `Error: No alternate named "${name}" found for ${field}. Available: ${availableNames.join(', ')}`;
            }
        } else {
            // If name is blank, choose a random alternate
            const randomIndex = Math.floor(Math.random() * fieldData.length);
            alternate = fieldData[randomIndex];
        }

        // Switch to the alternate
        ContextUtil.setCurrentField(fieldConfig, alternate.content);

        // return switched description
        return alternate.content;
    } catch (error) {
        console.error('Error in altfield command:', error);
        return `Error: ${error.message}`;
    }
}

// Initialize the extension
initializePersistence();
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeButtons, { once: true });
} else {
    initializeButtons();
}
registerSlashCommand();
