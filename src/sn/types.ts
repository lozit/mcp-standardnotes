export const NOTE_TYPES = [
  "plain-text",
  "markdown",
  "super",
  "code",
  "rich-text",
  "task",
  "spreadsheet",
  "authentication",
  "unknown",
] as const;

export type NoteType = (typeof NOTE_TYPES)[number];

export interface NoteSummary {
  uuid: string;
  title: string;
  updatedAt: string;
  preview: string;
  trashed: boolean;
  noteType: NoteType;
}

export interface Note {
  uuid: string;
  title: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  trashed: boolean;
  tags: string[];
  noteType: NoteType;
}

export interface TagSummary {
  uuid: string;
  title: string;
  updatedAt: string;
  noteCount: number;
}

export interface Tag {
  uuid: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  noteUuids: string[];
}

export interface VaultStats {
  notes: { total: number; active: number; trashed: number };
  tags: number;
  byNoteType: Record<string, number>;
  totalTextBytes: number;
  averageTextBytes: number;
  largest: { uuid: string; title: string; bytes: number } | null;
  oldest: { uuid: string; title: string; createdAt: string } | null;
  newest: { uuid: string; title: string; updatedAt: string } | null;
}
