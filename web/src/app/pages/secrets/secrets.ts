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
import { type ParsedCsv, parseCsvPasswords } from '../../core/csv-import';
import {
  type ImportResult,
  type ParsedKeePass,
  importKeePass,
  parseKeePassXml,
} from '../../core/keepass-import';
import { DEFAULT_PASSWORD_OPTIONS, generatePassword } from '../../core/password-generator';
import { accountTitle, parseMigration } from '../../core/authenticator-import';
import { QrScannerService } from '../../core/qr-scanner.service';
import {
  type Attachment,
  SecretsStore,
  type SecretEntry,
  type SecretFields,
  type SecretSecrets,
} from '../../core/secrets-store';
import { TOTP_DEFAULTS, type TotpConfig, parseTotp } from '../../core/totp';
import { TotpService } from '../../core/totp.service';

const EMPTY_FORM: SecretFields = {
  title: '',
  username: '',
  password: '',
  url: '',
  notes: '',
  attachments: [],
  groupId: null,
  totp: null,
  totpDigits: null,
  totpPeriod: null,
  totpAlgorithm: null,
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
  /**
   * Entries the user has opened on this screen. A row shows a name and an
   * address without opening anything; revealing, copying, editing or reading
   * a code is what asks the store for the sealed half, and the answer is kept
   * only while the page is up.
   */
  private readonly opened = signal<Map<string, SecretSecrets>>(new Map());
  private opening = new Set<string>();
  protected readonly notesRevealed = signal<Set<string>>(new Set());
  protected readonly search = signal('');
  /** Ids whose notes matched a deep search, or null when none has been run. */
  protected readonly notesMatches = signal<Set<string> | null>(null);
  protected readonly searchingNotes = signal(false);
  protected form: SecretFields = { ...EMPTY_FORM, attachments: [] };
  // Held in a signal (not on `form`) so async attach/remove updates re-render.
  protected readonly formAttachments = signal<Attachment[]>([]);

  // Two-factor codes. The box takes either a bare base32 secret or the whole
  // otpauth:// link a QR code holds, so whatever the user copied works.
  protected totpInput = '';
  /** Why the key was refused, or null; a message so it can name the reason. */
  protected readonly totpError = signal<string | null>(null);
  protected readonly totpAccepted = signal<string | null>(null);
  private readonly totp = inject(TotpService);
  protected readonly qr = inject(QrScannerService);
  protected readonly scanning = signal(false);

  /**
   * Scans the QR code the site is showing. Anything a QR code holds lands in
   * the same box the user could have typed into, so a code that is not an
   * otpauth link reports the same clear error as a bad paste.
   */
  protected async scanTotp(): Promise<void> {
    this.scanning.set(true);
    try {
      const value = await this.qr.scan();
      if (value === null) {
        return;
      }
      this.totpInput = value;
      this.onTotpInput(value);
    } catch {
      this.totpError.set(this.i18n.t('secrets.totpInvalid'));
    } finally {
      this.scanning.set(false);
    }
  }

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
    const alsoNotes = this.notesMatches();
    return items.filter(
      (entry) =>
        // Notes are sealed, so searching them would mean opening every entry;
        // searchNotes() does that, but only when asked.
        [entry.title, entry.username, entry.url, this.groups.path(entry.groupId)]
          .join('\n')
          .toLowerCase()
          .includes(query) ||
        (alsoNotes?.has(entry.id) ?? false),
    );
  });

  protected onSearchChange(value: string): void {
    this.search.set(value);
    // What the last deep search found no longer applies to a new query.
    this.notesMatches.set(null);
  }

  /**
   * Searches inside the notes as well. That means opening every entry that has
   * any, so it is a button rather than something typing does.
   */
  protected async searchNotes(): Promise<void> {
    const query = this.search().trim().toLowerCase();
    if (!query || this.searchingNotes()) {
      return;
    }
    this.searchingNotes.set(true);
    this.error.set(null);
    try {
      const matches = new Set<string>();
      for (const entry of this.store.items()) {
        if (!this.store.hasNotes(entry)) {
          continue;
        }
        const secrets = this.opened().get(entry.id) ?? (await this.store.open(entry.id));
        if (secrets.notes.toLowerCase().includes(query)) {
          matches.add(entry.id);
        }
      }
      this.notesMatches.set(matches);
    } catch {
      this.error.set(this.i18n.t('secrets.openFailed'));
    } finally {
      this.searchingNotes.set(false);
    }
  }

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

  protected readonly importPreview = signal<ParsedKeePass | ParsedCsv | null>(null);
  /** A browser export has no groups, so its preview reads differently. */
  protected readonly importCsv = signal<ParsedCsv | null>(null);
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
    this.importCsv.set(null);
    const text = await file.text();
    // KeePass exports XML, browsers export CSV; the file itself says which,
    // so the user does not have to pick the right button first.
    const isXml = text.trimStart().startsWith('<');
    try {
      if (isXml) {
        this.importPreview.set(parseKeePassXml(text));
      } else {
        const parsed = parseCsvPasswords(text);
        this.importCsv.set(parsed);
        this.importPreview.set(parsed);
      }
    } catch {
      this.error.set(this.i18n.t(isXml ? 'secrets.import.notKeePass' : 'secrets.import.notCsv'));
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
      this.importCsv.set(null);
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

  protected async startEdit(entry: SecretEntry): Promise<void> {
    this.error.set(null);
    let fields: SecretFields;
    try {
      // Editing is the one place that needs all of it at once.
      fields = await this.store.fields(entry.id);
    } catch {
      this.error.set(this.i18n.t('secrets.openFailed'));
      return;
    }
    this.form = { ...fields, attachments: [], groupId: this.groupOf(entry) };
    this.totpInput = fields.totp ?? '';
    this.totpError.set(null);
    this.totpAccepted.set(null);
    this.formAttachments.set([...fields.attachments]);
    this.editingId.set(entry.id);
    this.formOpen.set(true);
  }

  /**
   * The sealed half of a row, once it has been opened. Returns null the first
   * time and fills in a moment later, which re-renders whatever asked.
   */
  protected secretsOf(entry: SecretEntry): SecretSecrets | null {
    const known = this.opened().get(entry.id);
    if (known) {
      return known;
    }
    if (!this.opening.has(entry.id)) {
      this.opening.add(entry.id);
      void this.store
        .open(entry.id)
        .then((secrets) => {
          this.opened.update((map) => new Map(map).set(entry.id, secrets));
        })
        .catch(() => this.error.set(this.i18n.t('secrets.openFailed')))
        .finally(() => this.opening.delete(entry.id));
    }
    return null;
  }

  protected cancel(): void {
    this.formOpen.set(false);
    this.editingId.set(null);
    this.form = { ...EMPTY_FORM, attachments: [] };
    this.formAttachments.set([]);
    this.totpInput = '';
    this.totpError.set(null);
    this.totpAccepted.set(null);
  }

  /**
   * Accepts either a bare base32 secret or a whole otpauth:// link, so the
   * user can paste whatever the site gave them. An otpauth link also carries
   * the digit count and interval, which are kept when they are not the usual
   * ones.
   */
  protected onTotpInput(value: string): void {
    const text = (value ?? '').trim();
    if (!text) {
      this.form.totp = null;
      this.form.totpDigits = null;
      this.form.totpPeriod = null;
      this.form.totpAlgorithm = null;
      this.totpError.set(null);
      this.totpAccepted.set(null);
      return;
    }
    // An Authenticator export is a QR code too, and it is an easy one to
    // point this scanner at. One account can be taken here and then; a whole
    // list belongs on the screen built for it, so say so by name rather than
    // claiming the code is not a key.
    const config = parseTotp(text) ?? this.fromAuthenticatorExport(text);
    if (!config) {
      this.form.totp = null;
      this.totpAccepted.set(null);
      return;
    }
    this.form.totp = config.secret;
    this.form.totpDigits = config.digits === TOTP_DEFAULTS.digits ? null : config.digits;
    this.form.totpPeriod = config.period === TOTP_DEFAULTS.period ? null : config.period;
    this.form.totpAlgorithm =
      config.algorithm === TOTP_DEFAULTS.algorithm ? null : config.algorithm;
    this.totpError.set(null);
    this.totpAccepted.set(
      this.i18n.t('secrets.totpAccepted', {
        n: String(config.digits),
        s: String(config.period),
      }),
    );
  }

  /**
   * Reads an Authenticator export that holds a single account. Anything with
   * more than one is left to the import screen, and the message says which
   * screen that is.
   */
  private fromAuthenticatorExport(text: string): TotpConfig | null {
    let accounts;
    try {
      accounts = parseMigration(text).accounts;
    } catch {
      this.totpError.set(this.i18n.t('secrets.totpInvalid'));
      return null;
    }
    if (accounts.length !== 1) {
      this.totpError.set(this.i18n.t('secrets.totpMigration', { n: accounts.length }));
      return null;
    }
    const [account] = accounts;
    if (!this.form.title.trim()) {
      this.form.title = accountTitle(account);
    }
    return account;
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

  protected async toggleNotes(entry: SecretEntry): Promise<void> {
    if (!this.notesRevealed().has(entry.id)) {
      await this.openInto(entry);
    }
    this.notesRevealed.update((set) => {
      const next = new Set(set);
      next.has(entry.id) ? next.delete(entry.id) : next.add(entry.id);
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

  protected async toggleReveal(entry: SecretEntry): Promise<void> {
    if (!this.revealed().has(entry.id)) {
      await this.openInto(entry);
    }
    this.revealed.update((set) => {
      const next = new Set(set);
      next.has(entry.id) ? next.delete(entry.id) : next.add(entry.id);
      return next;
    });
  }

  /** Opens an entry and waits, for the paths that need it there and then. */
  private async openInto(entry: SecretEntry): Promise<SecretSecrets | null> {
    const known = this.opened().get(entry.id);
    if (known) {
      return known;
    }
    this.error.set(null);
    try {
      const secrets = await this.store.open(entry.id);
      this.opened.update((map) => new Map(map).set(entry.id, secrets));
      return secrets;
    } catch {
      this.error.set(this.i18n.t('secrets.openFailed'));
      return null;
    }
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

  // --- Two-factor codes ------------------------------------------------------

  protected codeOf(entry: SecretEntry): string {
    // A row with a code has to be opened to make one; that is a handful of
    // entries, not the whole vault.
    const secrets = this.secretsOf(entry);
    return secrets ? this.totp.liveCode(entry.id, secrets) : '······';
  }

  /** The live code for whatever is in the form right now, before saving. */
  protected formPreviewCode(): string {
    return this.totp.liveCode('form', this.form);
  }

  protected formPreviewLeft(): number {
    return this.totp.secondsLeft(this.form);
  }

  protected secondsLeft(entry: SecretEntry): number {
    const secrets = this.secretsOf(entry);
    return secrets ? this.totp.secondsLeft(secrets) : 0;
  }

  /** Copies the code itself, without the space that makes it readable. */
  protected async copyCode(entry: SecretEntry): Promise<void> {
    this.error.set(null);
    try {
      const secrets = await this.openInto(entry);
      const code = secrets ? await this.totp.codeFor(secrets) : null;
      if (!code) {
        return;
      }
      await this.clipboard.copyEphemeral(
        code,
        `${this.i18n.t('secrets.field.totp')} · ${entry.title}`,
      );
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
      const secrets = await this.openInto(entry);
      if (!secrets) {
        return;
      }
      await this.clipboard.copyEphemeral(
        secrets.password,
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
