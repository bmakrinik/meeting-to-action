import { Client } from "@notionhq/client";
import type { ActionItem } from "./postprocess";

let _client: Client | null = null;
function client(): Client {
  if (_client) return _client;
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN not set.");
  _client = new Client({ auth: token });
  return _client;
}

// Notion rich-text fields cap at 2000 chars per block. Split long text into chunks.
function chunk(text: string, size = 1900): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

function paragraph(text: string) {
  return {
    object: "block" as const,
    type: "paragraph" as const,
    paragraph: {
      rich_text: [{ type: "text" as const, text: { content: text } }],
    },
  };
}

function heading(text: string) {
  return {
    object: "block" as const,
    type: "heading_2" as const,
    heading_2: {
      rich_text: [{ type: "text" as const, text: { content: text } }],
    },
  };
}

function bullet(text: string) {
  return {
    object: "block" as const,
    type: "bulleted_list_item" as const,
    bulleted_list_item: {
      rich_text: [{ type: "text" as const, text: { content: text.slice(0, 1900) } }],
    },
  };
}

export interface WriteInput {
  databaseId: string;
  title: string;
  meetingTime?: string | null; // ISO; populates the Date property and a metadata line
  attendees?: string[];
  invited?: string[];
  host?: string | null;
  summary: string;
  actionItems: ActionItem[];
  transcript: string;
  unmappedSpeakers: string[];
}

export interface WriteResult {
  pageId: string;
  url: string;
}

// Defaults for fixed-value select properties (only applied if the option exists).
const PLATFORM = "Google Meet";
const WORKSPACE = ""; // e.g. your workspace/team name; left blank by default
const STATUS = "Summarized";

// Cache each database's property schema so we don't re-fetch it on every write.
const schemaCache = new Map<string, Record<string, any>>();
async function getSchema(dbId: string): Promise<Record<string, any>> {
  const cached = schemaCache.get(dbId);
  if (cached) return cached;
  const db: any = await client().databases.retrieve({ database_id: dbId });
  schemaCache.set(dbId, db.properties);
  return db.properties;
}

function richTextProp(text: string) {
  return { rich_text: [{ type: "text" as const, text: { content: text.slice(0, 1990) } }] };
}

// Build a properties object mapped to whatever the target database actually defines.
// Each field is set only when a property of the expected type exists, so the writer
// adapts to the schema instead of assuming fixed names.
function buildProperties(schema: Record<string, any>, input: WriteInput): any {
  const props: any = {};
  const byType = (type: string, names: string[]) =>
    names.find((n) => schema[n]?.type === type);
  const optionExists = (name: string, option: string) =>
    (schema[name]?.[schema[name].type]?.options || []).some(
      (o: any) => o.name === option
    );

  // Title (whatever the title property is called).
  const titleName = Object.keys(schema).find((n) => schema[n].type === "title");
  if (titleName) {
    props[titleName] = { title: [{ type: "text", text: { content: input.title } }] };
  }

  // Meeting date/time -> first matching date property.
  if (input.meetingTime) {
    const dateName = byType("date", ["Date & Time", "Date", "Meeting Date"]);
    if (dateName) props[dateName] = { date: { start: input.meetingTime } };
  }

  // Attendees -> multi_select (new option names are created automatically).
  if (input.attendees?.length) {
    const attName = byType("multi_select", ["Attendees"]);
    if (attName)
      props[attName] = {
        multi_select: input.attendees.slice(0, 100).map((a) => ({ name: a.slice(0, 100) })),
      };
  }

  // Host -> multi_select (single organizer).
  if (input.host) {
    const hostName = byType("multi_select", ["Host"]);
    if (hostName) props[hostName] = { multi_select: [{ name: input.host.slice(0, 100) }] };
  }

  // Invited -> multi_select (calendar guest list, when available).
  if (input.invited?.length) {
    const invName = byType("multi_select", ["Invited"]);
    if (invName)
      props[invName] = {
        multi_select: input.invited.slice(0, 100).map((a) => ({ name: a.slice(0, 100) })),
      };
  }

  // Summary -> a rich_text property.
  const sumName = byType("rich_text", ["New Summary", "Overview", "Summary", "Gist"]);
  if (sumName && input.summary) props[sumName] = richTextProp(input.summary);

  // Action items -> a rich_text property (plain text list; full detail is in the body).
  const aiName = byType("rich_text", ["Action Items", "Action items"]);
  if (aiName && input.actionItems.length) {
    const text = input.actionItems
      .map((a) => `• ${a.owner || "unassigned"}: ${a.task}${a.due ? ` (due ${a.due})` : ""}`)
      .join("\n");
    props[aiName] = richTextProp(text);
  }

  // Fixed-value selects: only set when both the property and the option already exist.
  const platform = byType("select", ["Platform"]);
  if (platform && optionExists(platform, PLATFORM)) props[platform] = { select: { name: PLATFORM } };
  const workspace = byType("select", ["Workspace"]);
  if (workspace && optionExists(workspace, WORKSPACE)) props[workspace] = { select: { name: WORKSPACE } };
  const status = byType("select", ["Status"]);
  if (status && optionExists(status, STATUS)) props[status] = { select: { name: STATUS } };

  return props;
}

// Create one Notion page per meeting: structured properties plus a body with the
// summary, owner-tagged action items, and full transcript.
export async function write(input: WriteInput): Promise<WriteResult> {
  const schema = await getSchema(input.databaseId);

  const children: any[] = [];
  children.push(heading("Summary"));
  for (const c of chunk(input.summary || "(no summary)")) children.push(paragraph(c));

  children.push(heading("Action items"));
  if (input.actionItems.length === 0) {
    children.push(paragraph("(none extracted)"));
  } else {
    for (const a of input.actionItems) {
      const owner = a.owner ? `**${a.owner}**` : "_unassigned_";
      const due = a.due ? ` (due ${a.due})` : "";
      children.push(bullet(`${owner}: ${a.task}${due}`));
    }
  }

  children.push(heading("Transcript"));
  for (const c of chunk(input.transcript || "(empty)")) children.push(paragraph(c));

  // Notion limits children to 100 blocks per create call; append the rest in batches.
  const first = children.slice(0, 100);
  const rest = children.slice(100);

  const page: any = await client().pages.create({
    parent: { database_id: input.databaseId },
    properties: buildProperties(schema, input),
    children: first,
  });

  for (let i = 0; i < rest.length; i += 100) {
    await client().blocks.children.append({
      block_id: page.id,
      children: rest.slice(i, i + 100),
    });
  }

  // "Transcript" URL property -> link to this page (the transcript lives in its body).
  // Done post-create because the page URL isn't known until the page exists.
  const transcriptProp = Object.keys(schema).find(
    (n) => schema[n].type === "url" && /transcript/i.test(n)
  );
  if (transcriptProp) {
    await client().pages.update({
      page_id: page.id,
      properties: { [transcriptProp]: { url: page.url } },
    });
  }

  return { pageId: page.id, url: page.url };
}
