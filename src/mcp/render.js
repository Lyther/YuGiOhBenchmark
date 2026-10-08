// Model-facing text for the seat's DTOs. Layout is not a stable interface (the
// JSON form is); nothing here drops or shortens content.

const MAIN_ZONES = 5;
const FIELD_ZONE = 5;
const UNKNOWN_STAT = -2;

const capitalize = (word) => word.charAt(0).toUpperCase() + word.slice(1);
const stat = (value) => (value === UNKNOWN_STAT ? "?" : String(value));

function cardText(card) {
  let text = card.name;
  if (card.atk !== undefined) text += card.def !== undefined ? ` ${stat(card.atk)}/${stat(card.def)}` : ` ${stat(card.atk)}`;
  if (card.position) text += ` ${card.position}`;
  const extras = [];
  // A monster's current Attribute and types, as printed cards show them: FIRE [Zombie/Effect/Tuner].
  if (card.attribute) extras.push(`${card.attribute} [${[card.race, ...(card.types ?? []).slice(1).map(capitalize)].filter(Boolean).join("/")}]`);
  if (card.level) extras.push(`Level ${card.level}`);
  if (card.rank) extras.push(`Rank ${card.rank}`);
  if (card.link) extras.push(`Link ${card.link}`);
  if (card.materials?.length) extras.push(`materials: ${card.materials.join(", ")}`);
  for (const { name, count } of card.counters ?? []) extras.push(`${count} ${name}`);
  if (card.equippedTo) extras.push(`equipped to ${card.equippedTo}`);
  if (card.targets?.length) extras.push(`targets: ${card.targets.join(", ")}`);
  if (card.scales) extras.push(`scales: ${card.scales.left}/${card.scales.right}`);
  if (card.negated) extras.push("negated");
  return extras.length ? `${text}, ${extras.join(", ")}` : text;
}

const slot = (card) => (card ? `[${cardText(card)}]` : "[-]");

function zoneLines(side) {
  const monsters = `  M: ${side.monsters.slice(0, MAIN_ZONES).map(slot).join(" ")} · EMZ: ${side.monsters.slice(MAIN_ZONES).map(slot).join(" ")}`;
  const field = side.spells[FIELD_ZONE] ? slot(side.spells[FIELD_ZONE]) : "-";
  const legacy = side.spells.slice(FIELD_ZONE + 1).map((card, index) => (card ? ` · S${FIELD_ZONE + 2 + index}: ${slot(card)}` : "")).join("");
  return [monsters, `  S: ${side.spells.slice(0, MAIN_ZONES).map(slot).join(" ")} · Field: ${field}${legacy}`];
}

function listLine(label, cards) {
  return cards.length ? [`  ${label}: ${cards.map(cardText).join(", ")}`] : [];
}

function boardLines(board) {
  const { opponent, you } = board;
  const turn = board.turnPlayer === "you" ? "your turn" : board.turnPlayer ? "opponent's turn" : "no turn yet";
  const lines = [`Duel ${board.duel} · Turn ${board.turn} · ${board.phase} · ${turn} · LP you ${board.lp.you} / opponent ${board.lp.opponent}`];
  lines.push(`Opponent: hand ${opponent.hand.count} · deck ${opponent.deck} · extra ${opponent.extra.count} · GY ${opponent.grave.length} · banished ${opponent.banished.length}`);
  lines.push(...zoneLines(opponent), ...listLine("GY", opponent.grave), ...listLine("Banished", opponent.banished));
  lines.push(...listLine("Revealed hand", opponent.hand.revealed), ...listLine("Face-up Extra", opponent.extra.faceUp));
  lines.push(`You: hand ${you.hand.length} · deck ${you.deck} · extra ${you.extra.length} · GY ${you.grave.length} · banished ${you.banished.length}`);
  lines.push(...zoneLines(you), ...listLine("Hand", you.hand), ...listLine("GY", you.grave));
  lines.push(...listLine("Banished", you.banished), ...listLine("Extra", you.extra));
  if (board.chain.length) {
    const links = board.chain.map((link) => {
      const flags = `${link.negated ? ", negated" : ""}${link.effect ? `: ${link.effect}` : ""}`;
      return `${link.n}) ${link.card.name} (${link.card.where}) by ${link.by}${flags}`;
    });
    lines.push(`Chain: ${links.join(" · ")}`);
  }
  return lines;
}

// Chat is another player's text: quoted, its line breaks cannot start lines
// that look like the seat's own. JSON.stringify leaves these breaks as they are.
const UNICODE_BREAKS = /[\u0085\u2028\u2029]/g;

function eventText(event) {
  if (event.kind !== "chat") return event.text;
  const quoted = JSON.stringify(event.text).replace(UNICODE_BREAKS, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `${event.from} says: ${quoted}`;
}

// Runs of identical automatic answers (empty chain windows) fold into one line.
function eventLines(events) {
  const lines = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    let last = index;
    while (event.kind === "auto" && events[last + 1]?.kind === "auto" && events[last + 1].text === event.text) last += 1;
    const count = last - index + 1;
    lines.push(count > 1 ? `  #${event.seq}-#${events[last].seq} ${eventText(event)} (×${count})` : `  #${event.seq} ${eventText(event)}`);
    index = last;
  }
  return lines.length ? ["Events:", ...lines] : [];
}

function optionSuffix(option) {
  if (option.tributes !== undefined) return ` · counts as ${option.tributes}`;
  if (option.values) return ` · value ${option.values.join(" or ")}`;
  if (option.counters !== undefined) return ` · holds ${option.counters}`;
  return "";
}

function promptLines(prompt) {
  const lines = [`Prompt ${prompt.seq} · ${prompt.kind}`, prompt.text];
  if (prompt.rejected) lines.push(`Rejected: ${prompt.rejected}`);
  if (prompt.sumTarget !== undefined) {
    const count = prompt.sumMode === "exactly" ? `, with ${prompt.min} to ${prompt.max} chosen cards` : ", with no spare card";
    lines.push(`Sum: ${prompt.sumMode} ${prompt.sumTarget}${count}`);
  }
  for (const card of prompt.mustInclude ?? []) lines.push(`Always included: ${card.label} · value ${card.values.join(" or ")}`);
  for (const option of prompt.options) lines.push(` ${option.n}) ${option.label}${optionSuffix(option)}`);
  lines.push(`Answer: ${prompt.answerHelp}`);
  return lines;
}

function statusLines(view) {
  if (view.prompt) return promptLines(view.prompt);
  if (view.disconnected) return [`Disconnected: ${view.disconnected}`];
  if (view.phase === "ended") return ["The match is over."];
  if (view.waiting === "server") return ["Waiting for the server to finish the match."];
  if (view.waiting === "rejoin") return ["Rejoining the match after a lost connection."];
  return view.waiting ? ["Waiting for the opponent."] : [];
}

export function renderSeat(view) {
  let header = `Phase: ${view.phase} · room ${view.room} · you: ${view.you.name}${view.you.host ? " (host)" : ""}`;
  if (view.opponent) header += ` · opponent: ${view.opponent}`;
  if (view.match.duel) {
    const { me, opponent, draws, unknown } = view.match.score;
    header += ` · duel ${view.match.duel}, score you ${me} - ${opponent} opponent${draws ? `, ${draws} draws` : ""}${unknown ? `, ${unknown} unknown` : ""}`;
  }
  return [header, ...(view.board ? boardLines(view.board) : []), ...eventLines(view.events), ...statusLines(view), `Next: ${view.next}`].join("\n");
}

function statsLine(card) {
  if (card.kind !== "monster") return [capitalize(card.kind), ...card.types.map(capitalize)].join(" · ");
  const parts = ["Monster", card.types.map(capitalize).join(", "), card.attribute, card.race];
  if (card.level) parts.push(`Level ${card.level}`);
  if (card.rank) parts.push(`Rank ${card.rank}`);
  if (card.link) parts.push(`Link ${card.link}`);
  parts.push(card.def !== undefined ? `ATK ${stat(card.atk)} / DEF ${stat(card.def)}` : `ATK ${stat(card.atk)}`);
  if (card.linkMarkers?.length) parts.push(`markers: ${card.linkMarkers.join(", ")}`);
  if (card.scales) parts.push(`Scales ${card.scales.left}/${card.scales.right}`);
  return parts.filter(Boolean).join(" · ");
}

export function renderCard(card) {
  const lines = [`${card.name} (${card.code})`, statsLine(card)];
  if (card.alias) lines.push(`Alternate artwork of #${card.alias}`);
  if (card.setnames?.length) lines.push(`Archetypes: ${card.setnames.join(", ")}`);
  lines.push(card.text);
  if (card.sourceNote) lines.push(`Source: ${card.sourceNote}`);
  return lines.join("\n");
}

function briefLine(card) {
  const parts = [capitalize(card.kind)];
  if (card.types.length) parts.push(card.types.map(capitalize).join(", "));
  if (card.attribute) parts.push(card.attribute);
  if (card.race) parts.push(card.race);
  if (card.level) parts.push(`Level ${card.level}`);
  if (card.rank) parts.push(`Rank ${card.rank}`);
  if (card.link) parts.push(`Link ${card.link}`);
  if (card.atk !== undefined) parts.push(card.def !== undefined ? `${stat(card.atk)}/${stat(card.def)}` : stat(card.atk));
  return `- ${card.name} (${card.code}): ${parts.join(" · ")}`;
}

export function renderSearch({ total, offset, cards }) {
  if (!total) return "No cards match.";
  const lines = [`${total} cards match; showing ${offset + 1}-${offset + cards.length}:`, ...cards.map(briefLine)];
  if (offset + cards.length < total) lines.push(`More: call card_search with offset ${offset + cards.length}.`);
  return lines.join("\n");
}

export function renderDeck(view) {
  const lines = [`Deck: Main ${view.counts.main} · Extra ${view.counts.extra} · Side ${view.counts.side}`];
  for (const [label, entries] of [["Main", view.main], ["Extra", view.extra], ["Side", view.side]]) {
    if (!entries.length) {
      lines.push(`${label}: (empty)`);
      continue;
    }
    lines.push(`${label}:`, ...entries.map((entry) => `  ${entry.count}x ${entry.name} (${entry.code})`));
  }
  return lines.join("\n");
}
