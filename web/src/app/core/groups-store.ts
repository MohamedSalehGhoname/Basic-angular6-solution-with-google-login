import { Injectable, computed } from '@angular/core';
import { type Entry, SyncedCollection } from './synced-collection';

interface GroupPayload {
  name: string;
  /** Emoji shown in the tree. */
  icon: string;
  /** Parent group id; null = top level. */
  parentId: string | null;
  createdAt: number;
}

export type GroupEntry = Entry<GroupPayload>;

/** A group with its children, for rendering the tree. */
export interface GroupNode {
  group: GroupEntry;
  depth: number;
  children: GroupNode[];
}

/** Icons offered when creating or editing a group (KeePass-style). */
export const GROUP_ICONS = [
  '📁', '🪟', '🌐', '🛟', '✉️', '🏦', '💳', '☁️', '🖥️', '🗄️', '🧰', '⚙️',
  '🔑', '🏠', '💼', '🛒', '📱', '🎮', '🎓', '🏥', '✈️', '📺', '👥', '🔒',
] as const;

export const DEFAULT_GROUP_ICON = '📁';
const MAX_GROUPS = 1000;

/**
 * Folders for secrets, like KeePass groups: nestable, named, with an icon.
 * Encrypted and synced like every other item; a secret points at its group
 * by id (see SecretsStore), and one whose group is gone shows at the top.
 */
@Injectable({ providedIn: 'root' })
export class GroupsStore extends SyncedCollection<GroupPayload> {
  constructor() {
    super('groups', MAX_GROUPS);
  }

  /** Top-level groups with their descendants, alphabetical at every level. */
  readonly tree = computed<GroupNode[]>(() => {
    const groups = this.items();
    const ids = new Set(groups.map((group) => group.id));
    const byParent = new Map<string | null, GroupEntry[]>();
    for (const group of groups) {
      // A group whose parent was deleted elsewhere is shown at the top.
      const parent = group.parentId && ids.has(group.parentId) ? group.parentId : null;
      byParent.set(parent, [...(byParent.get(parent) ?? []), group]);
    }
    const build = (parent: string | null, depth: number, seen: Set<string>): GroupNode[] =>
      (byParent.get(parent) ?? [])
        .filter((group) => !seen.has(group.id))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .map((group) => ({
          group,
          depth,
          children: build(group.id, depth + 1, new Set([...seen, group.id])),
        }));
    return build(null, 0, new Set());
  });

  /** Every group in tree order, for pickers. */
  readonly flat = computed<GroupNode[]>(() => {
    const out: GroupNode[] = [];
    const walk = (nodes: GroupNode[]) => {
      for (const node of nodes) {
        out.push(node);
        walk(node.children);
      }
    };
    walk(this.tree());
    return out;
  });

  byId(id: string | null | undefined): GroupEntry | undefined {
    return id ? this.items().find((group) => group.id === id) : undefined;
  }

  /** "Hosting › CloudFlare" for a group id; empty for none. */
  path(id: string | null | undefined): string {
    const names: string[] = [];
    const seen = new Set<string>();
    let group = this.byId(id);
    while (group && !seen.has(group.id)) {
      seen.add(group.id);
      names.unshift(group.name);
      group = this.byId(group.parentId);
    }
    return names.join(' › ');
  }

  /** The group and everything below it (to exclude when choosing a parent). */
  descendantsOf(id: string): Set<string> {
    const out = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const group of this.items()) {
        if (group.parentId && out.has(group.parentId) && !out.has(group.id)) {
          out.add(group.id);
          grew = true;
        }
      }
    }
    return out;
  }

  async addGroup(name: string, parentId: string | null, icon = DEFAULT_GROUP_ICON): Promise<GroupEntry | null> {
    if (!name.trim()) {
      return null;
    }
    return this.create({ name: name.trim(), icon, parentId, createdAt: Date.now() });
  }

  async saveGroup(id: string, changes: { name: string; icon: string; parentId: string | null }): Promise<void> {
    const existing = this.byId(id);
    if (!existing || !changes.name.trim()) {
      return;
    }
    // Never move a group under itself or its own descendants.
    const parentId =
      changes.parentId && this.descendantsOf(id).has(changes.parentId) ? existing.parentId : changes.parentId;
    await this.update(id, {
      name: changes.name.trim(),
      icon: changes.icon || DEFAULT_GROUP_ICON,
      parentId,
      createdAt: existing.createdAt,
    });
  }

  protected override compare(a: GroupEntry, b: GroupEntry): number {
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  }
}
