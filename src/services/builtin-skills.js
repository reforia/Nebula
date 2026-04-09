// Built-in skill content for all agents.
// Kept in a separate file to avoid bloating executor.js.

export const CODING_CONVENTIONS_SKILL = `# Coding Conventions

## Hierarchy & Polymorphism

### No child type checks in parent classes

A parent class must never check for a child's concrete type to branch behavior. This couples the parent to its descendants and violates open-closed principle.

\`\`\`python
# BAD — parent knows about child
if isinstance(instance, CombatAction):
    if instance._is_ready:
        await instance.proceed()

# GOOD — flag on parent, child sets it
if instance.is_ready_to_execute:
    await instance.proceed()
\`\`\`

\`\`\`cpp
// BAD — parent downcasts to child
if (auto* combat = dynamic_cast<CombatAction*>(instance)) {
    if (combat->is_ready)
        combat->proceed();
}

// GOOD — virtual method on parent, child overrides
if (instance->is_ready_to_execute())
    instance->proceed();
\`\`\`

**Fix patterns:**
- Flag/property on parent, child sets it during its lifecycle
- Virtual method on parent (default no-op), child overrides
- Event/callback the parent can await without knowing who emits

### Prefer composition over deep inheritance

If a class only needs one aspect of a parent, hold a reference instead of extending. Three levels of inheritance is a warning sign; four is almost always wrong.

### No type checks for branching logic in systems

Systems that operate on entities should use capabilities (has method, has component, has interface) rather than type checks. Duck typing, interfaces, and component queries scale; type hierarchies don't.

\`\`\`python
# BAD — system knows concrete types
if isinstance(entity, PlayerEntity):
    entity.show_damage_popup(amount)

# GOOD — capability check
if hasattr(entity, 'show_damage_popup'):
    entity.show_damage_popup(amount)
\`\`\`

\`\`\`cpp
// BAD — dynamic_cast chain
if (auto* player = dynamic_cast<PlayerEntity*>(entity))
    player->show_damage_popup(amount);

// GOOD — interface
if (auto* damageable = entity->get_component<IDamageable>())
    damageable->show_damage_popup(amount);
\`\`\`

---

## API Ownership

### Single owner for each method family

If both an entity and its component expose the same operation, one of them is a duplicate. Pick the canonical owner and route all callers there.

\`\`\`python
# BAD — same operation on two classes
# player.reset_action_points()  ← duplicates ActionComponent
# player.action_component.reset_action_points()

# GOOD — one canonical owner, callers go through it
player.get_action_component().reset_action_points()
\`\`\`

Thin convenience delegates are acceptable on test helpers but not on production base classes.

### Don't split read/write across layers

If \`set_x()\` lives on ComponentA, then \`get_x()\` should too. Splitting getters and setters across classes creates hidden coupling and forces callers to know which layer owns which half.

### Prefer local context over global reach

A class should get information from what it already knows — its owner, its parent, its component — not by reaching into a global singleton to re-discover the same thing. Every hop through a singleton is a coupling point that makes the class harder to test and reuse.

\`\`\`python
# BAD — action reaches into global manager to find its own owner
class HealAction(Action):
    def execute(self):
        player = TurnManager.get_active_entity()  # global reach
        player.health_component.apply_effect(self.heal_effect)

# GOOD — action uses what it already has
class HealAction(Action):
    def execute(self):
        self.owner.health_component.apply_effect(self.heal_effect)
\`\`\`

\`\`\`python
# BAD — effect reaches into global to find the board
class DamageEffect:
    def apply(self, card):
        board = GameManager.get_board()  # global reach
        for enemy in board.get_alive_enemies():
            enemy.take_damage(card.damage)

# GOOD — context is passed in
class DamageEffect:
    def apply(self, card, context):
        for enemy in context.get_targets():
            enemy.take_damage(card.damage)
\`\`\`

**The principle:** don't acquire more than you need, and don't take a longer path than necessary. If the data is one hop away through your owner, don't detour through a singleton.

**Singletons are for bootstrapping and cross-cutting concerns** (logging, config, metrics), not for navigating object relationships that already exist in your ownership chain.

### Single source of truth — don't cache derived state

If a value is already accessible through an authoritative source, query it directly. Don't copy it into a local variable or property that can go stale.

\`\`\`python
# BAD — caching health into a separate field
class Entity:
    def __init__(self):
        self._cached_health = 0  # stale the moment something else modifies health

    def take_damage(self, amount):
        self._cached_health -= amount  # diverges from actual source

# GOOD — always read from the source of truth
class Entity:
    def get_health(self):
        return self.stats.get_attribute("health")
\`\`\`

Acceptable exceptions:
- **Snapshot for comparison** — capture a "before" value to compare after an operation
- **Hot-loop optimization** — only if profiling proves the query is a bottleneck, and the cache is invalidated on every mutation
- **Local variable within a function** — if data won't mutate during execution (no re-entrant calls, no async yields), caching into a local is correct and preferred

\`\`\`python
# GOOD — local cache within a function, data won't mutate mid-execution
def apply_damage(self, amount):
    health = self.stats.get("health")
    armor = self.stats.get("armor")
    mitigated = max(amount - armor, 0)
    self.stats.set("health", health - mitigated)

# BAD — local cache across an await boundary (data may change while yielded)
async def apply_damage_over_time(self, amount):
    health = self.stats.get("health")  # stale after await
    await asyncio.sleep(1.0)
    self.stats.set("health", health - amount)  # WRONG: health may have changed
\`\`\`

**Member-level caches** persist across calls and go stale. **Local variable caches** live and die within a single synchronous call. When in doubt, re-query after any await, callback, or call into external code.

### Every member declaration must justify its ownership

For every field declared on a class, ask:

1. **Is this the source of truth?** If the same data exists elsewhere, this class should query it, not duplicate it.
2. **Is this class the best owner?** Data should live on the class that creates, mutates, and enforces invariants on it.

**Red flags** that a member doesn't belong:
- It's only written once (in the constructor) and never mutated — might be a constant or a query
- It mirrors a property on another object and is updated via events — query the source instead
- It's set by an external caller with no validation — the caller should own it
- Multiple classes hold the same value and sync them — pick one owner, others query it

---

## Architectural Patterns

### Always the proper fix, never the lazy fix

When fixing a bug, don't reach for the quickest patch that silences the symptom. Find the root cause and fix it at the right layer.

\`\`\`python
# LAZY FIX — internal not found? Guard with a null check
def setup_audio():
    if AudioManager._mix_state is None:   # poking at internals
        return
    AudioManager._mix_state._snapshots.append(snap)  # accessing private state

# PROPER FIX — add a public API upstream, use it cleanly
def setup_audio():
    AudioManager.register_snapshot(snap)
\`\`\`

The lazy fix works today but breaks when internals change. The proper fix works through the public contract and survives refactors.

**When you find yourself accessing private/internal members:**
1. Stop and ask: is there a public API that should exist but doesn't?
2. If yes: add it upstream, then use it
3. If the upstream isn't yours: wrap it in an adapter with a clear comment

### Bidirectional references are structural, not caches

A parent holding a list of children and children holding a back-pointer to their parent is a **structural relationship**. The rule against caching applies to **value copies that can diverge** — not structural pointers maintained as part of the same mutation.

\`\`\`python
# LEGITIMATE — bidirectional ownership link
class Container:
    def __init__(self):
        self._items: list[Item] = []

    def add_item(self, item: Item):
        self._items.append(item)
        item._container = self  # back-pointer updated in same operation

    def remove_item(self, item: Item):
        self._items.remove(item)
        item._container = None
\`\`\`

The key invariant: **the owner of the relationship mutates both sides**. The child never updates its own back-pointer directly.

### Choose data structures deliberately

Don't default to arrays/lists for everything. Pick the structure that matches the access pattern:

| Need | Structure | Why |
|------|-----------|-----|
| Ordered, iterate all | Array / List | Cache-friendly, index access |
| Fast lookup by key | HashMap / Dict | O(1) get/contains |
| Unique membership | HashSet / Set | O(1) membership test |
| FIFO processing | Queue / deque | Predictable order |
| Sorted priority | Priority queue / heap | Fast min/max |
| Bidirectional lookup | Two maps (key→val, val→key) | O(1) both directions |

\`\`\`python
# BAD — linear search for membership
tags: list[str] = []
def has_tag(self, tag: str) -> bool:
    return tag in self.tags  # O(n)

# GOOD — set semantics
tags: set[str] = set()
def has_tag(self, tag: str) -> bool:
    return tag in self.tags  # O(1)
\`\`\`

### Mutation flows downward, queries flow upward

In a well-structured system:
- **Mutation** flows from owner to owned: a manager tells a container to add an item, the container tells the item its new parent.
- **Queries** flow from leaf to root: an item asks its container for siblings, a container asks its manager for state.

When mutation flows upward (a child modifies its parent's state directly), the architecture is inverted.

\`\`\`python
# BAD — child mutates parent state directly
class Card:
    def play(self):
        self.zone.remove_card(self)      # child telling parent to mutate
        self.zone.discard.add_card(self)  # child reaching into sibling

# GOOD — child signals intent, mediator orchestrates
class Card:
    on_played: Event  # declare intent

# A mediator handles the structural change:
def on_card_played(card: Card):
    hand.remove_card(card)
    discard.add_card(card)
\`\`\`

**Queries upward are always fine.** A child querying its parent for context is not upward mutation.

### Separate state from presentation

Keep rules, state, and logic in plain classes. Views/UI observe state and render it. This makes the logic testable without a UI framework.

\`\`\`python
# BAD — business state lives on a UI widget
class EnemyWidget(Widget):
    health: int = 100
    attack: int = 10

# GOOD — state is pure data, widget observes
class EnemyData:
    health: int = 100
    attack: int = 10

class EnemyWidget(Widget):
    def __init__(self, data: EnemyData):
        self._data = data

    def render(self):
        self.opacity = self._data.health / 100.0
\`\`\`

---

## Lifecycle Contracts

### Don't duplicate framework cleanup

If a framework or base class handles cleanup (e.g., closing a connection in \`shutdown()\`), subclasses must not call it again. Double cleanup causes subtle bugs (double-fire events, use-after-free, double-close).

\`\`\`python
# BAD — subclass calls cleanup that base already handles
class MyAction(Action):
    async def execute(self, targets):
        # ... do work ...
        self.end()  # WRONG: base.proceed() already calls end()

# GOOD — subclass just does work, lifecycle is handled by caller
class MyAction(Action):
    async def execute(self, targets):
        # ... do work ...
\`\`\`

### Respect phase boundaries

Two-phase patterns (declare then execute, prepare then commit) exist for a reason. Don't collapse them unless you own both sides.

---

## Data Modeling

### No dictionaries/maps for structured data

Use typed classes instead of dicts/maps for anything that has a known shape. Dicts are for serialization boundaries or truly dynamic key-value mapping.

\`\`\`python
# BAD
result = {"damage": 10, "target": enemy, "crit": True}

# GOOD
@dataclass
class DamageResult:
    damage: int
    target: Entity
    crit: bool
\`\`\`

\`\`\`cpp
// BAD
std::map<std::string, std::any> result;
result["damage"] = 10;

// GOOD
struct DamageResult {
    int damage;
    Entity* target;
    bool crit;
};
\`\`\`

### Strong typing

Prefer explicit types over inference or dynamic typing. The compiler/type checker should catch mismatches at build time, not at runtime.

\`\`\`python
# BAD — no type hints
def apply_effect(target, amount, source=None):
    pass

# GOOD — fully typed
def apply_effect(target: Entity, amount: float, source: Entity | None = None) -> None:
    pass
\`\`\`

\`\`\`cpp
// BAD — auto everywhere hides intent
auto damage = calculate();
auto targets = get_targets();

// GOOD — types visible at declaration
float damage = calculate();
std::vector<Entity*> targets = get_targets();
\`\`\`

Use \`auto\`/inference only when the type is obvious from the right-hand side (e.g., \`auto it = map.find(key)\`).

---

## Test Quality

### No constructor-default tests

Tests that only verify hardcoded constructor values are brittle and add no behavioral coverage.

\`\`\`python
# BAD — tests implementation details
def test_slash_properties():
    action = Slash()
    assert action.name == "Slash"  # who cares
    assert action.speed == 5       # config might change

# GOOD — tests behavior
def test_slash_deals_damage():
    scenario.set_fixed_roll(3)
    scenario.execute_action(Slash(), target)
    assert scenario.target_health < 100, "Slash should deal damage"
\`\`\`

### No empty assertions

\`assert True\` or "didn't crash" tests nothing. Every test must assert observable state change.

\`\`\`python
# BAD
def test_take_damage():
    entity.take_damage(attacker, 25.0)
    assert True  # "didn't crash"

# GOOD
def test_take_damage():
    before = entity.health
    entity.take_damage(attacker, 25.0)
    assert entity.health < before, "Health should decrease"
\`\`\`

### Test behavior, not implementation

Tests should verify what the code does (outputs, state changes, events), not how it does it (internal method calls, private state). If you can refactor the internals without changing behavior, tests should still pass.

---

## Summary Checklist

When writing or reviewing code, verify:

- [ ] No child type checks (\`isinstance\`, \`dynamic_cast\`) in parent classes
- [ ] Each method family has one canonical owner
- [ ] No caching derived state — query the source of truth
- [ ] Prefer local context (owner, parent) over singleton reach for object relationships
- [ ] Every member justifies its ownership (is this the source? is this the right owner?)
- [ ] Bidirectional references maintained by the relationship owner, not by callers
- [ ] Data structure matches access pattern (not arrays for everything)
- [ ] Mutation flows downward (owner to owned), queries flow upward (leaf to root)
- [ ] State separated from presentation (testable without UI)
- [ ] Fixes address root cause at the right layer, not local hacks or internal access
- [ ] No duplicate cleanup calls
- [ ] Typed classes for structured data, not dicts/maps
- [ ] Strong typing on all function signatures and containers
- [ ] Tests assert behavior and state, not constructor defaults
- [ ] No empty assertions`;

/**
 * Intelligence scan SOP — universal research + reporting workflow.
 * @param {Object} opts
 * @param {string} opts.notifyEmail — configured notify_email_to address
 * @param {string} opts.orgName — organization name for report branding
 */
export function intelligenceScanSkill({ notifyEmail, orgName }) {
  return `# Intelligence Scan — Standard Operating Procedure

This skill defines how you produce scan reports. Follow it exactly.

## Phase 0: Context Recovery (MUST run first)

Each scan runs in a fresh session with no memory of previous scans. You MUST restore context before researching.

1. **Read your CLAUDE.md** — contains your active watchlist, current signals, and standing priorities. This is your working state.
2. **Search your memories** (use the nebula-memory skill) — search for previous scan findings, active watches, resolved signals, and domain learnings.
3. **Build your scan focus** — from CLAUDE.md watchlist + memory, identify active watches (WATCH items needing follow-up), standing priorities, and open ACT items. Research these FIRST in Phase 1, then expand to general domain scanning.

## Phase 1: Research

### Search Strategy
- Use WebSearch to find developments in your domain since your last scan
- For each finding, search for **at least 2 independent sources** before including it
- Prefer primary sources (official announcements, publisher blogs, patch notes, SEC filings, store pages) over aggregator rewrites
- If only one source exists, mark the finding as **[Unconfirmed]** and note it
- Discard rumors, speculation, or sources that cite each other circularly

### Source Credibility Tiers
- **Tier 1 (cite by preference):** Official company announcements, SEC/HKEX filings, engine changelogs, store pages (Steam, KS), peer-reviewed papers, GDC/conference proceedings
- **Tier 2 (acceptable):** Established trade press (GamesIndustry.biz, Gamasutra, PC Gamer, Eurogamer, TechCrunch, Ars Technica), reputable analytics (VGInsights, SteamDB, Sensor Tower)
- **Tier 3 (use cautiously, cross-check required):** YouTuber reports, Reddit threads, forum posts, personal blogs, social media. Always cross-check with Tier 1-2 before including.
- **Reject:** Anonymous leaks without corroboration, AI-generated listicles, SEO-farm articles, sources that only cite "reports say" without attribution

### Cross-Checking Protocol
- Numbers (revenue, units sold, player counts): verify against at least 2 sources or 1 Tier-1 source
- Dates (release dates, deadlines): verify against official source
- Claims about company strategy: prefer direct quotes or official statements over journalist interpretation
- If sources conflict, note the discrepancy — do not silently pick one

## Phase 2: Analysis

For EVERY finding, you MUST answer:
1. **What happened?** — State the fact clearly and concisely
2. **Why does this matter to ${orgName}?** — Connect it to our actual projects, position, or market
3. **What should we do?** — One of: ACT (specific action), WATCH (monitor for developments), or NOTE (informational, no action needed)

If a finding has no clear relevance to ${orgName}, do NOT include it. Industry noise is not intelligence.

### Relevance Filter
Ask yourself: "Would a decision-maker change a decision or prioritize differently because of this?" If no, cut it.

## Phase 3: Output — Two-Tier Report

### Tier 1: Conversation Brief (posted in your agent chat)
This is what the team sees first. It must be self-contained and scannable.

**Format:**
\`\`\`
## [Your Name] Scan — [Date]

### Summary
[2-3 sentences: the most important takeaways]

### Findings

#### 1. [Finding Title]
- **What:** [1-2 sentence factual summary]
- **Relevance:** [Why this matters to us specifically]
- **Action:** [ACT / WATCH / NOTE] — [specific recommendation]
- **Sources:** [Source1](URL1) | [Source2](URL2)

#### 2. [Finding Title]
[same structure]

### Internal Signals
[Any observations from internal tools (Gitea, CI, issue tracker) relevant to your domain — optional]
\`\`\`

**Rules for conversation brief:**
- Every finding MUST have at least one clickable source link
- Every finding MUST have a relevance line — no orphan facts
- Limit to 5-8 findings. Quality over quantity. Cut the weakest.
- Use plain language. No marketing buzzwords.
- Include numbers where available (revenue, player counts, ratings, dates)

### Tier 2: Email Full Report
Send the full report via the nebula-mail skill to **${notifyEmail || 'the configured notification address'}**.

**Format:** Use the **nebula-html-report** skill for all HTML formatting. Build the email using its standard components.

**Required sections (in order):**
1. **Report Header** — your name, scan domain tags, date
2. **Summary** — the 2-3 sentence summary in the summary box component
3. **Findings** — each as a finding card with priority badge, extended analysis (market context, historical comparison, competitive implications beyond the conversation brief), and source citations
4. **Internal Signals** — if applicable, use a data table for repo/build status
5. **Action Items** — grouped by priority (URGENT / HIGH / MEDIUM / LOW), using the action items component
6. **Footer** — agent name, org, scan type and date

**Additional content beyond conversation brief:**
- Extended analysis per finding (market context, historical comparison, competitive implications)
- Full source list with clickable links within each finding card

**Email subject format:** \`[Your Name] Scan — [Domain Summary] ([Date])\`

## Phase 4: Quality Checklist (self-verify before posting)
- [ ] Every finding has 2+ sources OR is marked [Unconfirmed]
- [ ] Every finding has a relevance line
- [ ] Every finding has at least one clickable URL in conversation brief
- [ ] No finding is pure industry noise with no connection to us
- [ ] Numbers are cross-checked (revenue, dates, player counts)
- [ ] Summary accurately reflects the most important findings
- [ ] Email sent with full analysis
- [ ] Conversation brief is posted and scannable without reading the email

## Phase 5: Persist State (MUST run after posting)

Use the nebula-memory skill for all memory operations below.

### Update CLAUDE.md
Update your CLAUDE.md with current tracking state — this is what Phase 0 reads next scan:
- **Active Watchlist** — WATCH items from this scan + still-active previous watches
- **Pending Actions** — ACT items not yet resolved
- **Last Scan Summary** — date, finding count, key themes
- Remove resolved items — drop concluded watches and completed actions

Keep it scannable — tables and bullet points, not prose.

### Store to Memory
- **Resolved signals** — items that concluded. Title: "Resolved: [signal name]". Forms historical knowledge.
- **Domain learnings** — cross-scan patterns (e.g. "competitor X releases on Thursdays"). Title: "Pattern: [description]".
- **Source quality notes** — unreliable or exceptional sources worth remembering.

Do NOT store raw findings — those are in the report. Memory is for meta-knowledge that improves future scans.

### Clean Up Memory
Delete memories no longer relevant (market moved on, signal fully resolved with no ongoing impact).

## Morning vs Evening Scans
- **Morning scan:** Full sweep of your domain. Cast wider net. Include both external signals and internal activity.
- **Evening scan:** Focus on developments SINCE the morning scan. Shorter. Flag anything that changed, escalated, or is newly confirmed. Reference morning findings if they evolved. Skip re-reporting unchanged items.`;
}

export const HTML_REPORT_SKILL = `# Nebula HTML Report — Component Library

Standard HTML components for Nebula email reports. When sending HTML email via nebula-mail, use these building blocks. Pass the assembled HTML as the \\\`html\\\` field in the send API — do not also set \\\`body\\\`.

Copy component patterns exactly. Do not invent custom styles.

## Color Palette

| Token | Hex | Usage |
|-------|-----|-------|
| nebula-black | #1A1A2E | Header/footer background |
| nebula-gold | #C9A227 | Accent — header bar, summary border |
| body-bg | #F4F4F5 | Outer page background |
| card-bg | #FFFFFF | Content area |
| text-primary | #1A1A2E | Headings |
| text-body | #374151 | Body copy |
| text-muted | #6B7280 | Timestamps, captions, footer |
| border | #E5E7EB | Dividers, card borders |

## Priority Badge Colors

All badges use the same pill style — only background-color changes:

| Badge | Background | When to use |
|-------|-----------|-------------|
| URGENT | #DC2626 | Immediate action, deadline imminent |
| HIGH | #D97706 | Important, act soon |
| ACT | #7C3AED | Specific action needed |
| MEDIUM | #2563EB | Standard priority |
| WATCH | #0891B2 | Monitor for developments |
| LOW | #059669 | Minor or informational with low-priority action |
| NOTE | #6B7280 | No action needed, awareness only |

## Base Document

Every HTML email starts with this skeleton. Place components as table rows inside the inner content table where marked.

\\\`\\\`\\\`html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>REPORT_TITLE</title>
</head>
<body style="margin:0; padding:0; background-color:#F4F4F5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#374151; font-size:14px; line-height:1.7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F4F4F5;">
<tr><td align="center" style="padding:24px 16px;">
  <table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px; width:100%; background-color:#FFFFFF; border-radius:8px; overflow:hidden; border:1px solid #E5E7EB;">

    <!-- HEADER -->
    <!-- CONTENT ROWS (sections, findings, tables, etc.) -->
    <!-- FOOTER -->

  </table>
</td></tr>
</table>
</body>
</html>
\\\`\\\`\\\`

## Components

### Report Header

Dark banner with report title and subtitle. Gold accent bar at bottom.

\\\`\\\`\\\`html
<tr>
  <td style="background-color:#1A1A2E; padding:28px 32px 20px; border-bottom:3px solid #C9A227;">
    <h1 style="margin:0; font-size:22px; font-weight:700; color:#FFFFFF;">Report Title Here</h1>
    <p style="margin:6px 0 0; font-size:13px; color:#9CA3AF;">2026-04-08 &middot; Morning sweep &middot; Domain tags here</p>
  </td>
</tr>
\\\`\\\`\\\`

### Section Heading

Used for major sections (Summary, Findings, Action Items, Sources, etc.).

\\\`\\\`\\\`html
<tr>
  <td style="padding:28px 32px 0;">
    <h2 style="margin:0 0 10px; font-size:18px; font-weight:700; color:#1A1A2E; border-bottom:2px solid #E5E7EB; padding-bottom:8px;">Section Title</h2>
  </td>
</tr>
\\\`\\\`\\\`

### Summary Box

Gold-accented box for the executive summary. Place after the first section heading.

\\\`\\\`\\\`html
<tr>
  <td style="padding:12px 32px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="background-color:#FFFBEB; border-left:4px solid #C9A227; padding:16px 20px; border-radius:0 6px 6px 0;">
          <p style="margin:0; font-size:14px; color:#374151; line-height:1.7;">Summary text here. Two to three sentences covering the most important takeaways.</p>
        </td>
      </tr>
    </table>
  </td>
</tr>
\\\`\\\`\\\`

### Finding Card

Each finding is a bordered card with a colored left accent matching its priority. Contains title with badge, body text, and source links.

\\\`\\\`\\\`html
<tr>
  <td style="padding:12px 32px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E7EB; border-left:4px solid PRIORITY_COLOR; border-radius:6px; overflow:hidden;">
      <tr>
        <td style="padding:16px 20px;">
          <h3 style="margin:0 0 8px; font-size:15px; font-weight:700; color:#1A1A2E;">
            BADGE_HERE Finding Title
          </h3>
          <p style="margin:0 0 8px; font-size:14px; color:#374151; line-height:1.7;"><strong>What:</strong> Factual summary of the finding.</p>
          <p style="margin:0 0 8px; font-size:14px; color:#374151; line-height:1.7;">Extended analysis, context, and implications.</p>
          <p style="margin:0; font-size:13px; color:#6B7280;">Sources: <a href="URL" style="color:#2563EB; text-decoration:none;">Source 1</a> | <a href="URL" style="color:#2563EB; text-decoration:none;">Source 2</a></p>
        </td>
      </tr>
    </table>
  </td>
</tr>
\\\`\\\`\\\`

Replace \\\`PRIORITY_COLOR\\\` with the badge's background color from the table above (e.g. #D97706 for HIGH).

### Priority Badge

Inline pill badge. Place inside headings or before text. Only change background-color and label.

\\\`\\\`\\\`html
<span style="display:inline-block; padding:2px 10px; border-radius:12px; font-size:11px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:#FFFFFF; background-color:#DC2626; margin-right:6px;">URGENT</span>
\\\`\\\`\\\`

Quick reference for badge backgrounds:
- URGENT: background-color:#DC2626
- HIGH: background-color:#D97706
- ACT: background-color:#7C3AED
- MEDIUM: background-color:#2563EB
- WATCH: background-color:#0891B2
- LOW: background-color:#059669
- NOTE: background-color:#6B7280

You can combine priority and action type: e.g. \\\`HIGH\\\` badge followed by \\\`ACT\\\` badge, or a single combined label like \\\`HIGH-ACT\\\`.

### Data Table

For metrics, build status, comparisons. Dark header, alternating row stripes.

\\\`\\\`\\\`html
<tr>
  <td style="padding:12px 32px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; border:1px solid #E5E7EB; border-radius:6px; overflow:hidden;">
      <tr>
        <th style="background-color:#1A1A2E; color:#FFFFFF; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; padding:10px 16px; text-align:left; border-bottom:1px solid #E5E7EB;">Column A</th>
        <th style="background-color:#1A1A2E; color:#FFFFFF; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; padding:10px 16px; text-align:left; border-bottom:1px solid #E5E7EB;">Column B</th>
        <th style="background-color:#1A1A2E; color:#FFFFFF; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; padding:10px 16px; text-align:left; border-bottom:1px solid #E5E7EB;">Column C</th>
      </tr>
      <tr>
        <td style="padding:10px 16px; font-size:13px; color:#374151; border-bottom:1px solid #E5E7EB; background-color:#FFFFFF;">Row 1 data</td>
        <td style="padding:10px 16px; font-size:13px; color:#374151; border-bottom:1px solid #E5E7EB; background-color:#FFFFFF;">Data</td>
        <td style="padding:10px 16px; font-size:13px; color:#374151; border-bottom:1px solid #E5E7EB; background-color:#FFFFFF;">Data</td>
      </tr>
      <tr>
        <td style="padding:10px 16px; font-size:13px; color:#374151; border-bottom:1px solid #E5E7EB; background-color:#F9FAFB;">Row 2 data</td>
        <td style="padding:10px 16px; font-size:13px; color:#374151; border-bottom:1px solid #E5E7EB; background-color:#F9FAFB;">Data</td>
        <td style="padding:10px 16px; font-size:13px; color:#374151; border-bottom:1px solid #E5E7EB; background-color:#F9FAFB;">Data</td>
      </tr>
    </table>
  </td>
</tr>
\\\`\\\`\\\`

Alternate row backgrounds between #FFFFFF and #F9FAFB. For status cells, use inline color:
- Success/OK: \\\`style="color:#059669; font-weight:700;"\\\`
- Failure/Error: \\\`style="color:#DC2626; font-weight:700;"\\\`

### Action Items

Group by priority level. Each item has a colored left-border marker.

\\\`\\\`\\\`html
<tr>
  <td style="padding:28px 32px 0;">
    <h2 style="margin:0 0 10px; font-size:18px; font-weight:700; color:#1A1A2E; border-bottom:2px solid #E5E7EB; padding-bottom:8px;">Action Items</h2>
  </td>
</tr>
<tr>
  <td style="padding:12px 32px 0;">
    <!-- Priority sub-heading -->
    <p style="margin:0 0 8px; font-size:13px; font-weight:700; color:#DC2626; text-transform:uppercase; letter-spacing:0.5px;">Urgent</p>
    <!-- Action item -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;">
      <tr>
        <td width="4" style="background-color:#DC2626; border-radius:2px;"></td>
        <td style="padding:8px 0 8px 14px; font-size:14px; color:#374151; line-height:1.6;">Action item description here</td>
      </tr>
    </table>
    <!-- Next priority group -->
    <p style="margin:16px 0 8px; font-size:13px; font-weight:700; color:#D97706; text-transform:uppercase; letter-spacing:0.5px;">High</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;">
      <tr>
        <td width="4" style="background-color:#D97706; border-radius:2px;"></td>
        <td style="padding:8px 0 8px 14px; font-size:14px; color:#374151; line-height:1.6;">Another action item</td>
      </tr>
    </table>
  </td>
</tr>
\\\`\\\`\\\`

Priority sub-heading colors: Urgent=#DC2626, High=#D97706, Medium=#2563EB, Low=#059669. Only include groups that have items.

### Report Footer

Dark bar matching header. Agent attribution and timestamp.

\\\`\\\`\\\`html
<tr>
  <td style="background-color:#1A1A2E; padding:20px 32px; margin-top:16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="border-top:2px solid #C9A227; padding-top:14px;">
          <p style="margin:0; font-size:12px; color:#9CA3AF;">Agent Name &middot; Organization Name &middot; 2026-04-08 morning sweep</p>
        </td>
      </tr>
    </table>
  </td>
</tr>
\\\`\\\`\\\`

## Composition Example

A complete report assembling all components. Use as a starting template — adjust sections and finding count to fit your report.

\\\`\\\`\\\`html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Market Intelligence Scan</title>
</head>
<body style="margin:0; padding:0; background-color:#F4F4F5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#374151; font-size:14px; line-height:1.7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F4F4F5;">
<tr><td align="center" style="padding:24px 16px;">
  <table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px; width:100%; background-color:#FFFFFF; border-radius:8px; overflow:hidden; border:1px solid #E5E7EB;">

    <!-- HEADER -->
    <tr>
      <td style="background-color:#1A1A2E; padding:28px 32px 20px; border-bottom:3px solid #C9A227;">
        <h1 style="margin:0; font-size:22px; font-weight:700; color:#FFFFFF;">Market Intelligence Scan</h1>
        <p style="margin:6px 0 0; font-size:13px; color:#9CA3AF;">2026-04-08 &middot; Morning sweep &middot; Monetization &middot; Distribution &middot; Crowdfunding</p>
      </td>
    </tr>

    <!-- SUMMARY -->
    <tr>
      <td style="padding:28px 32px 0;">
        <h2 style="margin:0 0 10px; font-size:18px; font-weight:700; color:#1A1A2E; border-bottom:2px solid #E5E7EB; padding-bottom:8px;">Summary</h2>
      </td>
    </tr>
    <tr>
      <td style="padding:12px 32px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="background-color:#FFFBEB; border-left:4px solid #C9A227; padding:16px 20px; border-radius:0 6px 6px 0;">
              <p style="margin:0; font-size:14px; color:#374151; line-height:1.7;">Two critical decisions this week: tariff ruling impacts board game costs, and settlement approval could unlock 14% revenue upside on cosmetics IAP. Crowdfunding benchmarks continue to validate IP licensing ceiling at $15M+.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- FINDINGS -->
    <tr>
      <td style="padding:28px 32px 0;">
        <h2 style="margin:0 0 10px; font-size:18px; font-weight:700; color:#1A1A2E; border-bottom:2px solid #E5E7EB; padding-bottom:8px;">Findings</h2>
      </td>
    </tr>

    <!-- Finding 1 -->
    <tr>
      <td style="padding:12px 32px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E7EB; border-left:4px solid #D97706; border-radius:6px; overflow:hidden;">
          <tr>
            <td style="padding:16px 20px;">
              <h3 style="margin:0 0 8px; font-size:15px; font-weight:700; color:#1A1A2E;">
                <span style="display:inline-block; padding:2px 10px; border-radius:12px; font-size:11px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:#FFFFFF; background-color:#D97706; margin-right:6px;">HIGH</span>
                <span style="display:inline-block; padding:2px 10px; border-radius:12px; font-size:11px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:#FFFFFF; background-color:#0891B2; margin-right:6px;">WATCH</span>
                Tariff Oral Arguments — April 10
              </h3>
              <p style="margin:0 0 8px; font-size:14px; color:#374151; line-height:1.7;"><strong>What:</strong> 24-state AGs challenging Section 122 10% tariff. Three-judge panel oral arguments April 10. If invalidated, operative rate drops from 25% to 15%.</p>
              <p style="margin:0 0 8px; font-size:14px; color:#374151; line-height:1.7;">This represents ~$0.60-0.80 per unit savings on board games from China. Finance model already accounts for both outcomes.</p>
              <p style="margin:0; font-size:13px; color:#6B7280;">Sources: <a href="https://example.com/cit-ruling" style="color:#2563EB; text-decoration:none;">CIT Docket</a> | <a href="https://example.com/tariff-analysis" style="color:#2563EB; text-decoration:none;">Trade Analysis</a></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Finding 2 -->
    <tr>
      <td style="padding:12px 32px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E7EB; border-left:4px solid #7C3AED; border-radius:6px; overflow:hidden;">
          <tr>
            <td style="padding:16px 20px;">
              <h3 style="margin:0 0 8px; font-size:15px; font-weight:700; color:#1A1A2E;">
                <span style="display:inline-block; padding:2px 10px; border-radius:12px; font-size:11px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:#FFFFFF; background-color:#7C3AED; margin-right:6px;">ACT</span>
                Update Co-Production Brief for Gamefound
              </h3>
              <p style="margin:0 0 8px; font-size:14px; color:#374151; line-height:1.7;"><strong>What:</strong> CMON returning H2 2026, crowdfunding platform must be Gamefound. Brass: Pittsburgh $4.77M validates Gamefound at $4M+ scale.</p>
              <p style="margin:0 0 8px; font-size:14px; color:#374151; line-height:1.7;">End-of-April deadline. CMON going-concern status creates urgency — company may pivot to IP sales if H2 crowdfunding fails.</p>
              <p style="margin:0; font-size:13px; color:#6B7280;">Sources: <a href="https://example.com/cmon" style="color:#2563EB; text-decoration:none;">CMON Announcement</a> | <a href="https://example.com/brass" style="color:#2563EB; text-decoration:none;">Gamefound – Brass</a></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- DATA TABLE EXAMPLE -->
    <tr>
      <td style="padding:28px 32px 0;">
        <h2 style="margin:0 0 10px; font-size:18px; font-weight:700; color:#1A1A2E; border-bottom:2px solid #E5E7EB; padding-bottom:8px;">Crowdfunding Benchmarks</h2>
      </td>
    </tr>
    <tr>
      <td style="padding:12px 32px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; border:1px solid #E5E7EB; border-radius:6px; overflow:hidden;">
          <tr>
            <th style="background-color:#1A1A2E; color:#FFFFFF; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; padding:10px 16px; text-align:left;">Campaign</th>
            <th style="background-color:#1A1A2E; color:#FFFFFF; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; padding:10px 16px; text-align:left;">Platform</th>
            <th style="background-color:#1A1A2E; color:#FFFFFF; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; padding:10px 16px; text-align:right;">Raised</th>
          </tr>
          <tr>
            <td style="padding:10px 16px; font-size:13px; color:#374151; border-bottom:1px solid #E5E7EB; background-color:#FFFFFF;">Cyberpunk TCG</td>
            <td style="padding:10px 16px; font-size:13px; color:#374151; border-bottom:1px solid #E5E7EB; background-color:#FFFFFF;">Kickstarter</td>
            <td style="padding:10px 16px; font-size:13px; color:#374151; border-bottom:1px solid #E5E7EB; background-color:#FFFFFF; text-align:right;">$15.4M</td>
          </tr>
          <tr>
            <td style="padding:10px 16px; font-size:13px; color:#374151; border-bottom:1px solid #E5E7EB; background-color:#F9FAFB;">Brass: Pittsburgh</td>
            <td style="padding:10px 16px; font-size:13px; color:#374151; border-bottom:1px solid #E5E7EB; background-color:#F9FAFB;">Gamefound</td>
            <td style="padding:10px 16px; font-size:13px; color:#374151; border-bottom:1px solid #E5E7EB; background-color:#F9FAFB; text-align:right;">$4.77M</td>
          </tr>
          <tr>
            <td style="padding:10px 16px; font-size:13px; color:#374151; background-color:#FFFFFF;">STS Downfall</td>
            <td style="padding:10px 16px; font-size:13px; color:#374151; background-color:#FFFFFF;">Kickstarter</td>
            <td style="padding:10px 16px; font-size:13px; color:#374151; background-color:#FFFFFF; text-align:right;">$4.96M</td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- ACTION ITEMS -->
    <tr>
      <td style="padding:28px 32px 0;">
        <h2 style="margin:0 0 10px; font-size:18px; font-weight:700; color:#1A1A2E; border-bottom:2px solid #E5E7EB; padding-bottom:8px;">Action Items</h2>
      </td>
    </tr>
    <tr>
      <td style="padding:12px 32px 0;">
        <p style="margin:0 0 8px; font-size:13px; font-weight:700; color:#DC2626; text-transform:uppercase; letter-spacing:0.5px;">Urgent</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;">
          <tr>
            <td width="4" style="background-color:#DC2626; border-radius:2px;"></td>
            <td style="padding:8px 0 8px 14px; font-size:14px; color:#374151; line-height:1.6;">Finalize co-production brief for Gamefound. Coordinate with BM Pacman + Finance. Deadline: end of April.</td>
          </tr>
        </table>
        <p style="margin:16px 0 8px; font-size:13px; font-weight:700; color:#D97706; text-transform:uppercase; letter-spacing:0.5px;">High</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;">
          <tr>
            <td width="4" style="background-color:#D97706; border-radius:2px;"></td>
            <td style="padding:8px 0 8px 14px; font-size:14px; color:#374151; line-height:1.6;">CIT Section 122 oral arguments April 10. Flag outcome to Finance immediately.</td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;">
          <tr>
            <td width="4" style="background-color:#D97706; border-radius:2px;"></td>
            <td style="padding:8px 0 8px 14px; font-size:14px; color:#374151; line-height:1.6;">Google Play settlement approval April 9. Defer mobile IAP design until ruling.</td>
          </tr>
        </table>
        <p style="margin:16px 0 8px; font-size:13px; font-weight:700; color:#2563EB; text-transform:uppercase; letter-spacing:0.5px;">Medium</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;">
          <tr>
            <td width="4" style="background-color:#2563EB; border-radius:2px;"></td>
            <td style="padding:8px 0 8px 14px; font-size:14px; color:#374151; line-height:1.6;">Monitor Cyberpunk TCG final close April 17-18. Flag if exceeds $16M.</td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- SPACER BEFORE FOOTER -->
    <tr><td style="padding:16px 0 0;"></td></tr>

    <!-- FOOTER -->
    <tr>
      <td style="background-color:#1A1A2E; padding:20px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="border-top:2px solid #C9A227; padding-top:14px;">
              <p style="margin:0; font-size:12px; color:#9CA3AF;">Monetization Agent &middot; Enigma Entertainment &middot; 2026-04-08 morning sweep</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

  </table>
</td></tr>
</table>
</body>
</html>
\\\`\\\`\\\`

## Email Client Notes

- All styles are inlined on elements. Do not rely on a \\\`<style>\\\` block alone — many email clients strip it.
- Use \\\`<table role="presentation">\\\` for layout, not \\\`<div>\\\`. Outlook requires table-based structure.
- Apply \\\`background-color\\\` on \\\`<td>\\\`, not \\\`<tr>\\\` (Outlook ignores it on rows).
- No flexbox, no grid, no CSS variables, no \\\`calc()\\\`.
- Use absolute URLs for any images. Always include \\\`alt\\\` text.
- The 680px max-width is standard — do not change it per report.
- Keep the font stack, color palette, and badge styles exactly as defined above.`;
