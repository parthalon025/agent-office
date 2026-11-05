import type { ReactNode } from "react";
export type Status = "working" | "waiting" | "error" | "resting" | "finished";
export type FloorKey = "ops" | "sales" | "research" | "content";
export interface PanelProps { title?: string; count?: ReactNode; flush?: boolean; className?: string; children?: ReactNode }
export interface StatusDotProps { status: Status }
export interface ModeToggleProps { value?: string; active?: string[]; options?: { id: string; label: string }[]; onChange?: (id: string) => void; label?: string }
export interface StatusCountsProps { counts: Partial<Record<"working" | "waiting" | "error" | "resting", number>> }
export interface FloorHeaderProps { floor: FloorKey; name: string; number: number; bots: number; working: number }
export interface ApprovalItemProps { name: string; floor?: number; ask: string; status?: "waiting" | "error"; onApprove?: () => void; onDecline?: () => void }
export interface ActivityLogProps { entries: { time: string; name: string; text: string }[] }
export interface UsageMeterProps { percent?: number; cost?: number; costLimit?: number; reset?: string; title?: string; rows?: { name: string; color: string; percent?: number; cost?: number }[] }
export interface StatusBubbleProps { status: Status; frame?: number }
export interface BotLineupProps { bots?: { shape: "blob" | "cone" | "octa" | "capsule"; color: string; status: Status }[]; spin?: number; height?: number; mode?: "auto" | "day" | "night" }
export type Role = "research" | "writer" | "coder" | "analyst" | "designer" | "ops" | "sales" | "planner" | "media" | "ae" | "specialist" | "partner" | "se" | "csa" | "csam" | "fde";
export type OfficeType = "team" | "lab" | "studio" | "hq";
/** Render quality. "auto" picks "high" on desktop and "medium" on touch devices and narrow views. "low" turns off post effects and the extra motion. */
export type Quality = "auto" | "high" | "medium" | "low";
export type Shape = "blob" | "cone" | "octa" | "capsule";
export interface BotDef { name?: string; sessions?: "agent" | "session"; orchestrator?: boolean; ephemeral?: boolean; shape?: Shape; color?: string; role?: Role; tasks?: string[]; status?: Status; task?: string; usage?: number; parent?: string; session?: string; platform?: string; identity?: string; owner?: string; model?: string; fallback?: string; tools?: string[]; knowledge?: string[]; skills?: string[]; channels?: string[]; triggers?: string[]; cost?: string; word?: string }
export interface RoomDef { id?: string; type: OfficeType; name?: string; bots: BotDef[] }
export interface FloorDef { id?: number; key?: FloorKey | "hq"; name?: string; rooms: RoomDef[] }
export interface BuildingDef { name?: string; sessions?: "agent" | "session"; floors: FloorDef[] }
export interface BuildingViewProps { building?: BuildingDef; quality?: Quality; simulate?: boolean; controls?: boolean; height?: number; mode?: "auto" | "day" | "night" }
export interface RoomSceneProps { type?: OfficeType; quality?: Quality; name?: string; bots?: BotDef[]; rooms?: RoomDef[]; floorKey?: FloorKey | "hq"; simulate?: boolean; height?: number; mode?: "auto" | "day" | "night" }
export interface WorkstationsProps { roles?: Role[]; cols?: number; cycle?: boolean; height?: number; mode?: "auto" | "day" | "night" }
export interface RoomListProps { rooms: { id: string; name: string; type: OfficeType; bots: number; working: number }[]; current?: string | null; onSelect?: (id: string) => void; onAddBot?: (roomId: string) => void; onAddRoom?: (type: OfficeType) => void }
export interface BotAvatarProps { shape: Shape; color: string; status?: Status; size?: number }
export interface OfficeTypeBadgeProps { type: OfficeType; label?: string }
export interface OfficeTypeCardProps { type: OfficeType; note?: string }
export interface RoleBadgeProps { role: Role }
export interface AddButtonProps { onClick?: () => void; label?: string; children?: ReactNode }
export interface ViewToggleProps { value: "floor" | "building"; onChange?: (v: "floor" | "building") => void }
export interface IconProps { name: string; size?: number; label?: string; color?: string }
export interface LogoProps { variant?: "mark" | "wordmark" | "lockup"; size?: number; height?: number }
/** Fields every event can carry (schema `common`). */
export interface EventCommon {
  /** State the office already had, sent again when a scene mounts. The scene applies it, but records no history, plays no sound, sends no notification or toast, and adds no unread count or Activity line. */
  seeded?: boolean;
  /** Time of the event in ms. A seeded event with `at` after the last time the building was seen is news: it adds unread counts and Activity lines, and Since you left counts it. */
  at?: number;
}
/** Events an adapter emits into the office. The scene changes ONLY from these. */
export type AgentEvent = EventCommon & (
  | { type: "status"; bot: string; status: Status; task?: string; quiet?: boolean }
  | { type: "message"; bot: string; text: string; say?: boolean; attachments?: Record<string, unknown>[]; format?: string }
  | { type: "message.agent"; from: string; to: string; text: string; walk?: boolean; attachments?: Record<string, unknown>[] }
  | { type: "request"; bot: string; id?: string; text: string; actions?: string[]; quiet?: boolean; risk?: string; cost?: number; preview?: string; tool?: string }
  | { type: "error"; bot: string; text: string }
  | { type: "usage"; percent?: number; bots?: Record<string, number>; cost?: number; costLimit?: number; costs?: Record<string, number> }
  | { type: "session.start"; bot: string; session: string; title?: string; isolated?: boolean }
  | { type: "session.end"; bot: string; session: string; result?: string; ok?: boolean }
  | { type: "plan"; bot: string; goal: string; steps: Record<string, unknown>[] }
  | { type: "plan.step"; bot: string; id: string; status: Status; owner?: string }
  | { type: "delegate"; bot: string; to?: string; spawn?: Record<string, unknown>; roomId?: string; task?: string }
  | { type: "subagent.done"; bot: string; result?: string; remove?: boolean }
  | { type: "tool.call"; bot: string; id: string; tool: string; kind?: string; args?: Record<string, unknown>; say?: boolean }
  | { type: "tool.result"; bot: string; id: string; ok?: boolean; ms?: number; summary?: string; tokens?: number; cost?: number }
  | { type: "knowledge"; bot: string; source: string; text?: string }
  | { type: "skill.load"; bot: string; skill: string }
  | { type: "checkpoint"; bot: string; id: string; label: string; files?: number }
  | { type: "rollback"; bot: string; label: string }
  | { type: "trigger.run"; job: string; bot?: string; next?: string }
  | { type: "model"; bot: string; model: string; fallback?: string }
  | { type: "floor.add"; floor: Record<string, unknown> }
  | { type: "room.add"; floorId: number; room: Record<string, unknown> }
  | { type: "floor.update"; floorId: number; floor: Record<string, unknown> }
  | { type: "room.update"; roomId: string; room: Record<string, unknown> }
  | { type: "bot.add"; roomId: string; bot: BotDef }
  | { type: "bot.remove"; bot: string });
/** Commands the office sends to the adapter when the user acts. `bots` is filled in by the office. */
export type AgentCommand = { bots?: string[] } & (
  | { type: "message"; bot?: string; target?: Record<string, unknown>; targetLabel?: string; text: string; attachments?: Record<string, unknown>[] }
  | { type: "approve"; bot: string; requestId?: string }
  | { type: "decline"; bot: string; requestId?: string }
  | { type: "retry"; bot: string }
  | { type: "dismiss"; bot: string }
  | { type: "pause"; bot: string }
  | { type: "resume"; bot: string }
  | { type: "assign"; bot: string; task: string; from?: string }
  | { type: "delegate"; bot: string; to: string; task: string }
  | { type: "rollback"; bot: string; checkpoint: Record<string, unknown> }
  | { type: "session.stop"; bot: string; session: string }
  | { type: "cron.pause"; job: string }
  | { type: "cron.resume"; job: string });
export interface AdapterContext { emit(ev: AgentEvent): void; bots(): { name: string; role: Role; status: Status; task: string; tasks: string[]; floor: number; room: string }[]; getBuilding(): BuildingDef }
export interface AgentAdapter { name?: string; init(ctx: AdapterContext): void; send(cmd: AgentCommand): Promise<unknown> | unknown; dispose?(): void }
export interface OfficeApi { history(sinceMs?: number): { t: number; ev: AgentEvent }[]; summary(sinceMs?: number): { since: number; finished: number; waiting: number; errors: number; toolCalls: number; tokens: number; cost: number; sessions: number; messages: number; events: number; byBot: Record<string, { finished: number; errors: number; tokens: number; cost: number }>; top: string[] }; replay(opts: { from?: number; to?: number; speed?: number }): { from: number; to: number; speed: number; events: number }; stopReplay(): boolean; approveMany(bots: string[]): Promise<unknown[]>; declineMany(bots: string[]): Promise<unknown[]>; setFrameInset(inset: { left: number; right: number } | null): void; stopSession(bot: string, sessionId: string): Promise<unknown>; validate(ev: AgentEvent): { ok: boolean; errors: string[] }; screenPos(bot: string): { x: number; y: number; visible: boolean } | null; setSound(on: boolean): void; quality: Quality; inspect(): { nav: Record<number, unknown>; bots: unknown[]; floor: number; stage: unknown }; send(cmd: AgentCommand): Promise<unknown>; message(bot: string, text: string): Promise<unknown>; broadcast(target: { room?: string; floor?: number; all?: boolean }, text: string, label?: string): Promise<unknown>; approve(bot: string): Promise<unknown>; decline(bot: string): Promise<unknown>; retry(bot: string): Promise<unknown>; applyEvent(ev: AgentEvent): void; connect(a: AgentAdapter | null): void; setView(v: "floor" | "building"): void; setFloor(id: number): void; /** Zoom by a factor inside the controls' minZoom and maxZoom. A step never goes the wrong way. Returns the new zoom. */ zoom(factor: number): number; focusRoom(id: string | null): void; addFloor(f?: Partial<FloorDef>): number; addRoom(floorId: number, r?: Partial<RoomDef>): string; addBot(roomId: string, b?: Partial<BotDef>): string; removeBot(name: string): void; select(name: string | null): void; chatOf(name: string): unknown[]; getBuilding(): BuildingDef; dispose(): void }
export interface SessionListProps { sessions: { id: string; title: string; status: "working" | "finished" | "error"; time: string; end?: string; result?: string; blob?: string }[]; onStop?: (sessionId: string) => void }
export interface AgentChatProps { loading?: boolean; disabled?: boolean; bot: { name: string; shape: Shape; color: string; role?: Role; status: Status; task: string }; messages: ChatMessageData[]; connected?: boolean; attach?: boolean; onSend?: (text: string, attachments?: ChatAttachment[]) => void; onAction?: (type: "approve" | "decline" | "retry", request?: unknown) => void; onClose?: () => void }
export interface BroadcastBarProps { disabled?: boolean; targets: { id: string; label: string; target: { room?: string; floor?: number; all?: boolean } }[]; value?: string | null; onChange?: (id: string) => void; onSend?: (target: unknown, text: string) => void }
export interface SolutionCardProps { solution: { id: string; label: string; summary: string; building: BuildingDef }; onUse?: () => void }
/** The kit schema (kit/schema.json, also at AgentOffice.schema): one entry for each event and command, and the shared enums and types. A field type ends with ? when the field is optional. */
export interface AgentSchema { version: string; events: Record<string, { desc: string; fields: Record<string, string> }>; commands: Record<string, { desc: string; fields: Record<string, string> }>; enums: Record<string, string[]>; types: Record<string, { desc: string; fields: Record<string, string> }> }
/** The globals the DS adds to `AgentOffice` (see Reference.md, Office API). The components are also on it, by name. */
export interface AgentOfficeGlobals {
  /** The 10 bot body colors, in the order the scene gives them to new bots. A page that sets bot.color reads them from here, so a bot looks the same in every list. */
  BODY_COLORS: readonly string[];
  /** One portrait color for each bot shape (4 colors). The portraits use it when a bot has no color. For a bot color, use BODY_COLORS. */
  BOT_COLORS: Readonly<Record<Shape, string>>;
  /** Checks one event (or, with kind "commands", one command) against the schema. Reports missing fields, wrong types and unknown fields. */
  validate(x: unknown, kind?: "events" | "commands"): { ok: boolean; errors: string[] };
  schema: AgentSchema;
  /** Set to true to warn in the console on each event that does not match the schema. */
  strict?: boolean;
  /** The one money format of the DS: "$0.26", "<$0.01" for a cost above zero and under one cent. A string passes through. */
  money(n: number | string | null | undefined): string;
  adapters: { mock(opts?: Record<string, unknown>): AgentAdapter; create(o: { name?: string; subscribe?(emit: (ev: AgentEvent) => void, ctx: AdapterContext): void; send?(cmd: AgentCommand, ctx: AdapterContext | null): Promise<unknown> | unknown; dispose?(): void }): AgentAdapter };
  office: { mount(el: HTMLElement, opts?: Record<string, unknown>): OfficeApi; [name: string]: unknown };
  [name: string]: unknown;
}
declare global { interface Window { AgentOffice: AgentOfficeGlobals } }
/** AgentOffice.adapters.mock(opts) and AgentOffice.adapters.create({ name, subscribe(emit), send(cmd), dispose }) build adapters. AgentOffice.office.mount(el, opts) returns OfficeApi. */
export interface TooltipProps { text: string; side?: "top" | "bottom"; open?: boolean; children: ReactNode }
export interface ToastProps { tone?: "info" | "success" | "warning" | "error"; title?: string; text: string; action?: { label: string; onClick: () => void }; onClose?: () => void }
export interface ToastStackProps { toasts: (ToastProps & { id: string | number })[]; onClose?: (id: string | number) => void }
export interface DialogProps { open: boolean; title: string; onClose?: () => void; actions?: ReactNode; inline?: boolean; children?: ReactNode }
export interface TabsProps { tabs: { id: string; label: string; icon?: string; count?: number; content?: ReactNode }[]; value?: string; onChange?: (id: string) => void; label?: string; render?: (id: string) => ReactNode }
export interface TextInputProps { id?: string; label?: string; value?: string; defaultValue?: string; placeholder?: string; hint?: string; error?: string; disabled?: boolean; type?: string; onChange?: (value: string) => void }
export interface SelectProps { id?: string; label?: string; ariaLabel?: string; options: { value: string; label: string }[]; value?: string; defaultValue?: string; hint?: string; error?: string; disabled?: boolean; onChange?: (value: string) => void }
export interface EmptyStateProps { icon?: string; title: string; text?: string; compact?: boolean; action?: { label: string; icon?: string; onClick: () => void } }
export interface SkeletonProps { lines?: number; avatar?: boolean; label?: string }
export interface ButtonProps { variant?: "primary" | "quiet" | "danger" | "ghost"; size?: "md" | "lg"; icon?: string; loading?: boolean; disabled?: boolean; label?: string; title?: string; type?: "button" | "submit"; onClick?: () => void; children?: ReactNode }
export interface ToolCallData { id: string; tool: string; kind?: "mcp" | "connector" | "code" | "terminal" | "browser" | "computer" | "flow" | "knowledge" | "skill" | "memory" | "search" | "api"; args?: unknown; ok?: boolean; ms?: number; summary?: string }
export interface TraceStep { type: "plan" | "delegate" | "subagent.done" | "tool.call" | "knowledge" | "skill.load" | "checkpoint" | "rollback" | "trigger.run" | "model"; title: string; text?: string; time?: string; state?: "run" | "done" | "error"; call?: ToolCallData; checkpoint?: { id: string; label: string } }
export interface ToolCallProps { call: ToolCallData; open?: boolean }
export interface RunTraceProps { steps: TraceStep[]; onRollback?: (checkpoint: { id: string; label: string }) => void }
export interface PlanCardProps { title?: string; goal?: string; steps: { id: string; text: string; status?: Status; owner?: string }[] }
export interface DelegationTreeProps { tree: { name: string; shape?: Shape; color?: string; status?: Status; task?: string; ephemeral?: boolean; children?: DelegationTreeProps["tree"][] }; max?: number; onSelect?: (name: string) => void }
export interface ScheduleListProps { jobs: { id: string; name: string; when: string; kind?: "cron" | "event"; bot?: string; next?: string; paused?: boolean }[]; onToggle?: (job: unknown) => void }
export interface CheckpointTimelineProps { checkpoints: { id: string; label: string; time: string; files?: number }[]; onRollback?: (cp: unknown) => void }
export interface AgentCardProps { agent: { name: string; shape?: Shape; color?: string; status?: Status; platform?: string; owner?: string; identity?: string; model?: string; fallback?: string; tools?: string[]; knowledge?: string[]; skills?: string[]; channels?: string[]; triggers?: string[]; cost?: string } }
export interface AgentRegistryProps { agents: { name: string; shape?: Shape; color?: string; status?: Status; platform?: string; identity?: string; model?: string; tools?: string[]; access?: "scoped" | "broad"; last?: string }[]; onSelect?: (agent: AgentRegistryProps["agents"][number]) => void; selected?: string }
export interface ChannelListProps { channels: { id: string; name: string; route?: string; today?: number }[] }
export interface CostMeterProps { tokens?: number; cost?: number; cached?: number }
export interface ModelBadgeProps { model: string; fallback?: string }
export interface ToolKindBadgeProps { kind: ToolCallData["kind"] }
/** An extra tab for AgentPanel. `render` gets the bot and returns the tab content. `after` is the id of the tab it follows (default: last). */
export interface AgentPanelTab { id: string; label: string; icon?: string; count?: number | null; after?: string; render: (bot: AgentPanelProps["bot"]) => ReactNode }
export interface AgentPanelProps extends AgentChatProps { tab?: "chat" | "trace" | "sessions" | "agent"; activeTab?: string; extraTabs?: AgentPanelTab[]; hideTabs?: ("chat" | "trace" | "sessions" | "agent")[]; onTabChange?: (id: string) => void; steps?: TraceStep[]; plan?: { goal?: string; steps: PlanCardProps["steps"] } | null; cost?: CostMeterProps; agent?: AgentCardProps["agent"]; onRollback?: (cp: unknown) => void }
/** Orchestration events (x0.8): plan, plan.step, delegate { bot, to?, spawn?, task }, subagent.done { bot, result }, tool.call { bot, id, tool, kind, args }, tool.result { bot, id, ok, ms, summary, tokens, cost }, knowledge, skill.load, checkpoint, rollback, trigger.run { job }, model { bot, model, fallback }. Commands: delegate, rollback, cron.pause, cron.resume. */
export interface OfficeSceneProps { agentTab?: string; inbox?: boolean; onInbox?: (open: boolean) => void; notifier?: boolean; waitingCount?: number; extraTabs?: AgentPanelTab[]; hideTabs?: ("chat" | "trace" | "sessions" | "agent")[]; onTabChange?: (id: string) => void; onNotify?: (n: { kind: "request" | "error"; bot: string; text: string; risk?: "low" | "medium" | "high" | null }) => void; frameInset?: { left: number; right: number } | null; ambient?: boolean; onAmbientOpen?: () => void; sinceYouLeft?: boolean; building?: BuildingDef; solution?: "hq" | "microsoft" | "hermes" | "copilot"; adapter?: AgentAdapter | null; theme?: "light" | "dark" | "sublevel"; floor?: number; view?: "floor" | "building"; mode?: "auto" | "day" | "night" | "sublevel"; simulate?: boolean; editable?: boolean; hud?: boolean; toasts?: boolean; height?: number; reset?: string; quality?: Quality; intro?: boolean; sound?: boolean; onReady?: (office: OfficeApi) => void; onSelect?: (botName: string | null) => void }
export interface FloorListProps { floors: { id: number; name: string; statuses: Status[]; rooms?: number }[]; current: number | null; onSelect?: (id: number) => void; onAdd?: () => void }
export interface BotRowProps { name: string; color: string; shape?: Shape; role?: Role; status: Status; task: string; selected?: boolean; onClick?: () => void }
export interface SinceYouLeftProps { summary: { since: number; finished: number; waiting: number; errors: number; toolCalls: number; tokens: number; cost: number; sessions: number; messages: number; byBot?: Record<string, { finished: number; errors: number; tokens: number; cost: number }>; top?: string[] }; now?: number; onReplay?: () => void; onDecisions?: () => void; onClose?: () => void }
export interface TimeScrubberProps { history: { count: number; first: number; last: number }; replay: { playing: boolean; from: number; to: number; t: number; speed: number } | null; onPlay?: (from: number, speed: number) => void; onPause?: () => void; onStop?: () => void; onSeek?: (t: number) => void }
export interface DecisionInboxProps { bots: { name: string; color?: string; shape?: "blob" | "cone" | "octa" | "capsule"; role?: string; status?: "working" | "waiting" | "error" | "resting" | "finished"; task?: string; floor?: number; room?: string; orchestrator?: boolean; request: { id?: string; text: string; actions?: string[]; risk?: "low" | "medium" | "high"; cost?: number | string; preview?: string; tool?: string } | null }[]; maxHeight?: number | string; onApprove?: (name: string) => void; onDecline?: (name: string) => void; onApproveMany?: (names: string[]) => void; onDeclineMany?: (names: string[]) => void; onOpen?: (name: string) => void }
export interface CommandPaletteProps { open: boolean; onClose?: () => void; onOpen?: () => void; hotkey?: string; inline?: boolean; bots?: { name: string; color?: string; shape?: "blob" | "cone" | "octa" | "capsule"; role?: string; status?: "working" | "waiting" | "error" | "resting" | "finished"; task?: string; floor?: number; room?: string; orchestrator?: boolean }[]; floors?: { id: number; name: string; key?: string }[]; managerName?: string | null; actions?: { id: string; label: string; icon?: string; group?: string; keywords?: string; hint?: string; hidden?: boolean; run: () => void }[]; onBot?: (name: string) => void; onFloor?: (id: number) => void; onAsk?: (text: string) => void }
export interface NotifierProps { notifications: { id: string; kind?: "request" | "error" | "finished"; bot?: string; text?: string; risk?: "low" | "medium" | "high" }[]; enabled: boolean; count?: number; title?: boolean; onClick?: (notification: { id: string; kind?: "request" | "error" | "finished"; bot?: string; text?: string; risk?: "low" | "medium" | "high" }) => void }
export interface NotifyToggleProps { enabled: boolean; onChange?: (enabled: boolean) => void }
export interface AmbientBarProps { floors: { id: number; key?: string; name: string; rooms: { id: string; bots: { name: string; status: "working" | "waiting" | "error" | "resting" | "finished"; request?: { id?: string; text: string } | null }[] }[] }[]; log?: { time: string; name: string; text: string }[]; last?: { time?: string; name: string; text: string } | null; name?: string; onOpen?: () => void }
export interface RiskBadgeProps { risk?: "low" | "medium" | "high" }
export declare function useHotkey(key: string | null, fn: (e: KeyboardEvent) => void, opt?: { mod?: boolean }): void
export interface ChatAttachment { type: "image" | "file" | "link" | "video" | "audio"; url: string; name?: string; size?: number; mime?: string; alt?: string; title?: string; description?: string; site?: string; thumb?: string; width?: number; height?: number }
export interface ChatMessageData { from: "user" | "agent" | "system"; text: string; time?: string; to?: string; request?: { id: string; answered?: "approve" | "decline" }; attachments?: ChatAttachment[] | null; format?: "plain" | "markdown" | null }
export interface RichTextProps { text: string; format?: "plain" | "markdown"; tone?: "default" | "inverse"; collapseAt?: number; className?: string }
export interface ChatMessageProps { message: ChatMessageData; collapseAt?: number; onAction?: (type: "approve" | "decline", request?: unknown) => void }
export interface ComposerProps { id?: string; label?: string; placeholder?: string; disabled?: boolean; attach?: boolean; before?: unknown; addRef?: { current: ((files: FileList | File[]) => void) | null }; onSend?: (text: string, attachments?: ChatAttachment[]) => void }
export interface RichApi { parse(md: string, opts?: { plain?: boolean }): unknown[]; tokens(md: string): Record<string, unknown>[]; inline(text: string, opts?: { plain?: boolean; noLink?: boolean }): Record<string, unknown>[]; info(md: string): { code: boolean; table: boolean; image: boolean; images: { src: string; alt: string; name: string }[] }; images(md: string): { src: string; alt: string; name: string }[]; galleryOf(md: string, attachments?: ChatAttachment[] | null): { src: string; alt: string; name: string }[]; kind(a: ChatAttachment): string; iconFor(a: ChatAttachment): string; safeUrl(url: string, kind: "link" | "img" | "media" | "file" | "card", allowBlob?: boolean): string | null; host(url: string): string | null; size(bytes: number): string | null; /** Host of an http(s) image URL (the browser's form), or null for data: and blob: */ remoteHost(url: string): string | null; /** False for a remote image until the user clicks its load button; true for data: and blob: */ imageShown(url: string): boolean }
