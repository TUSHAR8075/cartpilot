// Claude tool-use loop: the shopper talks, the agent searches, builds a cart and starts PayPal checkout.
import Anthropic from "@anthropic-ai/sdk";
import { toolDefs, runTool } from "./tools.js";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY
const MODEL = () => process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const MAX_STEPS = 8;

const SYSTEM = `You are CartPilot, a shopping agent that buys things for the user through PayPal.

How you work:
- Clarify only what is essential (budget, size, use case). If the user gives a budget, call set_budget first.
- Search with focused queries, compare 2-3 options briefly (price, rating, why it fits) and recommend one.
- Add items to the cart only when the user asks or clearly agrees. Respect the budget strictly.
- Before checkout, summarise the cart and total and ask for confirmation. Call checkout only after the user says yes.
- After checkout, tell the user to approve the payment with the PayPal button. You cannot capture payment yourself.
- Refunds: confirm order and amount with the user, then call refund_order.
- Autopilot: the shopper can save PayPal once (the "Connect PayPal" button in the Autopilot panel) and set spending limits.
  You can then create price watches; Autopilot buys automatically when a target is hit, never above the
  per-order or monthly limits (enforced in code). Confirm product, target price and quantity before creating a watch.
  Set limits only to amounts the shopper states. Autopilot purchases can be undone (refunded) from the activity log or via refund_order.
- Products may come from real merchants (Channel3 catalog). Mention the merchant and any discount ("was $X") when useful.
  Checkout runs in PayPal Sandbox, so no real money moves and real merchants don't fulfil orders. Don't claim delivery.
- Prices are in USD. Be concise: short paragraphs or bullets, no long essays.`;

export async function chat(session, userText) {
  const events = [];
  const emit = (e) => events.push(e);
  // Events that happened between turns (e.g. Autopilot purchases) are passed along as context.
  const notes = session.notes?.splice(0) || [];
  const content = notes.length ? `[system events since last message: ${notes.join(" | ")}]\n\n${userText}` : userText;
  session.messages.push({ role: "user", content });

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await client.messages.create({
      model: MODEL(),
      max_tokens: 1500,
      system: SYSTEM,
      tools: toolDefs,
      messages: session.messages,
    });
    session.messages.push({ role: "assistant", content: res.content });

    if (res.stop_reason !== "tool_use") {
      const reply = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      return { reply, events };
    }

    const results = [];
    for (const block of res.content.filter((b) => b.type === "tool_use")) {
      emit({ type: "tool", name: block.name, input: block.input });
      let output;
      try {
        output = await runTool(block.name, block.input, session, emit);
      } catch (e) {
        console.error(`[tool ${block.name}]`, e.message, e.details || "");
        output = { error: e.message };
      }
      results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(output) });
    }
    session.messages.push({ role: "user", content: results });
  }
  return { reply: "I hit my step limit for this request. Could you rephrase or narrow it down?", events };
}
