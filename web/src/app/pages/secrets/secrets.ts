import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClipboardCopyService } from '../../core/clipboard-copy.service';
import {
  DEFAULT_GROUP_ICON,
  GROUP_ICONS,
  type GroupNode,
  GroupsStore,
} from '../../core/groups-store';
import { I18nService } from '../../core/i18n/i18n.service';
import { fileToAttachment } from '../../core/image-utils';
import {
  type ImportResult,
  type ParsedKeePass,
  importKeePass,
  parseKeePassXml,
} from '../../core/keepass-import';
import { DEFAULT_PASSWORD_OPTIONS, generatePassword } from '../../core/password-generator';
import {
  type Attachment,
  SecretsStore,
  type SecretEntry,
  type SecretFields,
} from '../../core/secrets-store';

const EMPTY_FORM: SecretFields = {
  title: '',
  username: '',
  password: '',
  url: '',
  notes: '',
  attachments: [],
  groupId: null,
};

const EXPANDED_KEY = 'clipsync.secrets.expanded';
const SECRET_DRAG_TYPE = 'application/x-clipsync-secret';

interface GroupDialog {
  /** Group being edited; absent when creating. */
  id?: string;
  name: string;
  icon: string;
  parentId: string | null;
}

@Component({
  selector: 'app-secrets',
  imports: [FormsModule],
  templateUrl: './secrets.html',
  styleUrls: ['./secrets.css', './secrets-groups.css'],
})
export class Secrets {
  protected readonly store = inject(SecretsStore);
  protected readonly groups = inject(GroupsStore);
  protected readonly clipboard = inject(ClipboardCopyService);
  protected readonly i18n = inject(I18nService);
  protected readonly icons = GROUP_ICONS;

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  /** null = closed, '' = adding, id = editing that entry. */
  protected readonly editingId = signal<string | null>(null);
  protected readonly formOpen = signal(false);
  protected readonly revealed = signal<Set<string>>(new Set());
  protected readonly notesRevealed = signal<Set<string>>(new Set());
  protected readonly search = signal('');
  protected form: SecretFields = { ...EMPTY_FORM, attachments: [] };
  // Held in a signal (not on `form`) so async attach/remove updates re-render.
  protected readonly formAttachments = signal<Attachment[]>([]);

  protected readonly editingTitle = computed(() => {
    const id = this.editingId();
    return id ? (this.store.items().find((entry) => entry.id === id)?.title ?? '') : '';
  });

  // --- Groups ---------------------------------------------------------------

  /** Selected group; null = the top level (entries in no group). */
  protected readonly selectedGroup = signal<string | null>(null);
  protected readonly expanded = signal<Set<string>>(this.readExpanded());
  protected readonly groupDialog = signal<GroupDialog | null>(null);
  /** Group row a password is being dragged over (null = top level). */
  protected readonly dropTarget = signal<string | null | undefined>(undefined);

  /** Tree rows currently visible (children of collapsed groups are hidden). */
  protected readonly visibleNodes = computed<GroupNode[]>(() => {
    const out: GroupNode[] = [];
    const open = this.expanded();
    const walk = (nodes: GroupNode[]) => {
      for (const node of nodes) {
        out.push(node);
        if (open.has(node.group.id)) {
          walk(node.children);
        }
      }
    };
    walk(this.groups.tree());
    return out;
  });

  /** Direct entry count per group id ('' = top level). */
  protected readonly counts = computed(() => {
    const counts = new Map<string, number>();
    for (const entry of this.store.items()) {
      const key = this.groupOf(entry) ?? '';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  });

  protected readonly selectedGroupName = computed(() => {
    const id = this.selectedGroup();
    return id ? (this.groups.byId(id)?.name ?? '') : this.i18n.t('secrets.rootGroup');
  });

  /** Search looks across every group; otherwise show the selected group. */
  protected readonly filtered = computed(() => {
    const query = this.search().trim().toLowerCase();
    const items = this.store.items();
    if (!query) {
      const selected = this.selectedGroup();
      return items.filter((entry) => this.groupOf(entry) === selected);
    }
    return items.filter((entry) =>
      [entry.title, entry.username, entry.url, entry.notes, this.groups.path(entry.groupId)]
        .join('\n')
        .toLowerCase()
        .includes(query),
    );
  });

  constructor() {
    void this.init();
  }

  private async init(): Promise<void> {
    try {
      await Promise.all([this.store.load(), this.groups.load()]);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not load your secrets.');
    } finally {
      this.loading.set(false);
    }
  }

  /** A secret's effective group: its own if that still exists, else the top level. */
  protected groupOf(entry: SecretEntry): string | null {
    return entry.groupId && this.groups.byId(entry.groupId) ? entry.groupId : null;
  }

  protected selectGroup(id: string | null): void {
    this.selectedGroup.set(id);
    this.search.set('');
  }

  protected toggleExpanded(id: string, event?: Event): void {
    event?.stopPropagation();
    this.expanded.update((set) => {
      const next = new Set(set);
      next.has(id) ? next.delete(id) : next.add(id);
      this.writeExpanded(next);
      return next;
    });
  }

  protected isExpanded(id: string): boolean {
    return this.expanded().has(id);
  }

  protected newGroup(): void {
    this.groupDialog.set({ name: '', icon: DEFAULT_GROUP_ICON, parentId: this.selectedGroup() });
  }

  protected editGroup(): void {
    const group = this.groups.byId(this.selectedGroup());
    if (group) {
      this.groupDialog.set({
        id: group.id,
        name: group.name,
        icon: group.icon,
        parentId: group.parentId,
      });
    }
  }

  protected patchGroupDialog(changes: Partial<GroupDialog>): void {
    this.groupDialog.update((dialog) => (dialog ? { ...dialog, ...changes } : dialog));
  }

  /** Parents a group may move under: anything but itself and its descendants. */
  protected parentChoices(dialog: GroupDialog): GroupNode[] {
    const excluded = dialog.id ? this.groups.descendantsOf(dialog.id) : new Set<string>();
    return this.groups.flat().filter((node) => !excluded.has(node.group.id));
  }

  /** Indented label for a group in a <select> (options cannot hold markup). */
  protected indented(node: GroupNode): string {
    return `${'\u00A0\u00A0\u00A0'.repeat(node.depth)}${node.group.icon} ${node.group.name}`;
  }

  protected async saveGroupDialog(): Promise<void> {
    const dialog = this.groupDialog();
    if (!dialog || !dialog.name.trim()) {
      return;
    }
    this.error.set(null);
    try {
      if (dialog.id) {
        await this.groups.saveGroup(dialog.id, dialog);
      } else {
        const created = await this.groups.addGroup(dialog.name, dialog.parentId, dialog.icon);
        if (created) {
          if (dialog.parentId) {
            const next = new Set(this.expanded()).add(dialog.parentId);
            this.expanded.set(next);
            this.writeExpanded(next);
          }
          this.selectedGroup.set(created.id);
        }
      }
      this.groupDialog.set(null);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not save the group.');
    }
  }

  /** Deletes the selected group; its passwords and subgroups move up to its parent. */
  protected async deleteGroup(): Promise<void> {
    const group = this.groups.byId(this.selectedGroup());
    if (!group) {
      return;
    }
    const entries = this.store.items().filter((entry) => this.groupOf(entry) === group.id);
    const children = this.groups.items().filter((child) => child.parentId === group.id);
    const parentName = this.groups.byId(group.parentId)?.name ?? this.i18n.t('secrets.rootGroup');
    const message = this.i18n.t('secrets.deleteGroupConfirm', {
      name: group.name,
      n: entries.length,
      g: children.length,
      parent: parentName,
    });
    if (!confirm(message)) {
      return;
    }
    this.error.set(null);
    try {
      for (const entry of entries) {
        await this.store.move(entry.id, group.parentId);
      }
      for (const child of children) {
        await this.groups.saveGroup(child.id, { ...child, parentId: group.parentId });
      }
      this.groups.remove(group.id);
      this.selectedGroup.set(group.parentId);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not delete the group.');
    }
  }

  // Drag a password onto a group in the tree to move it there.
  protected onDragStart(event: DragEvent, entry: SecretEntry): void {
    event.dataTransfer?.setData(SECRET_DRAG_TYPE, entry.id);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
    }
  }

  protected onDragOver(event: DragEvent, groupId: string | null): void {
    if (event.dataTransfer?.types.includes(SECRET_DRAG_TYPE)) {
      event.preventDefault();
      this.dropTarget.set(groupId);
    }
  }

  protected onDragLeave(groupId: string | null): void {
    if (this.dropTarget() === groupId) {
      this.dropTarget.set(undefined);
    }
  }

  protected async onDrop(event: DragEvent, groupId: string | null): Promise<void> {
    event.preventDefault();
    this.dropTarget.set(undefined);
    const id = event.dataTransfer?.getData(SECRET_DRAG_TYPE);
    if (!id) {
      return;
    }
    try {
      await this.store.move(id, groupId);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not move the password.');
    }
  }

  // --- KeePass import ------------------------------------------------------

  protected readonly importPreview = signal<ParsedKeePass | null>(null);
  protected readonly importProgress = signal<{ done: number; total: number } | null>(null);
  protected readonly importResult = signal<ImportResult | null>(null);

  protected async onImportFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }
    this.error.set(null);
    this.importResult.set(null);
    try {
      this.importPreview.set(parseKeePassXml(await file.text()));
    } catch {
      this.error.set(this.i18n.t('secrets.import.notKeePass'));
    }
  }

  protected async runImport(): Promise<void> {
    const parsed = this.importPreview();
    if (!parsed || this.importProgress()) {
      return;
    }
    this.error.set(null);
    this.importProgress.set({ done: 0, total: parsed.entryCount + parsed.groupCount });
    try {
      const result = await importKeePass(parsed, this.groups, this.store, (done, total) =>
        this.importProgress.set({ done, total }),
      );
      this.importResult.set(result);
      this.importPreview.set(null);
      this.selectGroup(null);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'The import stopped part-way.');
    } finally {
      this.importProgress.set(null);
    }
  }

  // --- Entries ---------------------------------------------------------------

  protected startAdd(): void {
    this.form = { ...EMPTY_FORM, attachments: [], groupId: this.selectedGroup() };
    this.formAttachments.set([]);
    this.editingId.set('');
    this.formOpen.set(true);
  }

  protected startEdit(entry: SecretEntry): void {
    this.form = {
      title: entry.title,
      username: entry.username,
      password: entry.password,
      url: entry.url,
      notes: entry.notes,
      attachments: [],
      groupId: this.groupOf(entry),
    };
    this.formAttachments.set([...(entry.attachments ?? [])]);
    this.editingId.set(entry.id);
    this.formOpen.set(true);
  }

  protected cancel(): void {
    this.formOpen.set(false);
    this.editingId.set(null);
    this.form = { ...EMPTY_FORM, attachments: [] };
    this.formAttachments.set([]);
  }

  protected async onAttachImages(input: HTMLInputElement): Promise<void> {
    const files = Array.from(input.files ?? []);
    input.value = '';
    this.error.set(null);
    for (const file of files) {
      try {
        const attachment = await fileToAttachment(file);
        this.formAttachments.update((list) => [...list, attachment]);
      } catch (err) {
        this.error.set(err instanceof Error ? err.message : 'Could not attach the image.');
      }
    }
  }

  protected removeAttachment(index: number): void {
    this.formAttachments.update((list) => list.filter((_, i) => i !== index));
  }

  protected toggleNotes(id: string): void {
    this.notesRevealed.update((set) => {
      const next = new Set(set);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  protected isNotesRevealed(id: string): boolean {
    return this.notesRevealed().has(id);
  }

  protected async submit(): Promise<void> {
    if (!this.form.title.trim()) {
      this.error.set('A title is required.');
      return;
    }
    this.error.set(null);
    try {
      const fields: SecretFields = { ...this.form, attachments: this.formAttachments() };
      const id = this.editingId();
      if (id) {
        await this.store.save(id, fields);
      } else {
        await this.store.add(fields);
      }
      this.cancel();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not save the secret.');
    }
  }

  protected async remove(entry: SecretEntry): Promise<void> {
    if (!confirm(this.i18n.t('secrets.deleteConfirm', { title: entry.title }))) {
      return;
    }
    this.error.set(null);
    try {
      this.store.remove(entry.id);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not delete the secret.');
    }
  }

  protected toggleReveal(id: string): void {
    this.revealed.update((set) => {
      const next = new Set(set);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  protected isRevealed(id: string): boolean {
    return this.revealed().has(id);
  }

  protected async copyUsername(entry: SecretEntry): Promise<void> {
    this.error.set(null);
    try {
      await this.clipboard.copy(entry.username);
    } catch {
      this.error.set('Could not copy to the clipboard.');
    }
  }

  protected generatePassword(): void {
    this.form.password = generatePassword(DEFAULT_PASSWORD_OPTIONS);
    // Reveal so the user can see what was generated.
    this.showFormPassword.set(true);
  }

  protected readonly showFormPassword = signal(false);

  protected toggleFormPassword(): void {
    this.showFormPassword.update((v) => !v);
  }

  protected async copyPassword(entry: SecretEntry): Promise<void> {
    this.error.set(null);
    try {
      await this.clipboard.copyEphemeral(
        entry.password,
        `${this.i18n.t('secrets.field.password')} · ${entry.title}`,
      );
    } catch {
      this.error.set('Could not copy to the clipboard.');
    }
  }

  private readExpanded(): Set<string> {
    try {
      return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  }

  private writeExpanded(set: Set<string>): void {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...set]));
    } catch {
      // View state only.
    }
  }
}
