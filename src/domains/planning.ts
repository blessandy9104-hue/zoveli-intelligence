import { IntelligenceInputError } from '../errors.js';
import { clip, hashObject, sha256 } from '../text.js';
import type { DomainResult, PlanResult, PlanStep } from '../types.js';

type PlanCategory = PlanResult['category'];

interface PlanInput {
  objective: string;
  constraints?: string[];
  deadline?: string;
  context?: string;
}

const CATEGORY_KEYWORDS: Array<{ category: PlanCategory; terms: readonly string[] }> = [
  {
    category: 'research',
    terms: ['research', 'investigate', 'find out', 'sources', 'compare', 'survey', 'evidence'],
  },
  {
    category: 'build',
    terms: ['build', 'create', 'implement', 'develop', 'ship', 'code', 'app', 'website', 'feature', 'prototype'],
  },
  {
    category: 'write',
    terms: ['write', 'draft', 'article', 'essay', 'report', 'documentation', 'blog', 'email', 'copy'],
  },
  {
    category: 'analyze',
    terms: ['analyze', 'review', 'audit', 'assess', 'evaluate', 'diagnose', 'measure', 'metrics'],
  },
  {
    category: 'organize',
    terms: ['organize', 'schedule', 'plan', 'clean', 'file', 'sort', 'itinerary', 'travel', 'move', 'inbox'],
  },
  {
    category: 'learn',
    terms: ['learn', 'study', 'practice', 'master', 'course', 'teach', 'understand'],
  },
];

const TEMPLATES: Record<Exclude<PlanCategory, 'generic'>, Array<Omit<PlanStep, 'id'>>> = {
  research: [
    {
      title: 'Frame the question',
      action: 'Write the decision the research must support and the scope boundaries.',
      doneWhen: 'The question, audience, and excluded topics are one paragraph.',
      verification: 'Owner confirms the framing before any source is collected.',
    },
    {
      title: 'Collect local evidence',
      action: 'Gather primary sources and notes; record source, date, and claim for each.',
      doneWhen: 'Every claim has at least one traceable source.',
      verification: 'Cross-check each source against the original, not a summary.',
    },
    {
      title: 'Compare findings',
      action: 'Group findings by agreement, disagreement, and unknowns.',
      doneWhen: 'Conflicts and gaps are listed explicitly.',
      verification: 'A second pass tries to falsify the leading conclusion.',
    },
    {
      title: 'Write the answer',
      action: 'Draft a decision-first summary with citations.',
      doneWhen: 'Each recommendation points to evidence and states confidence.',
      verification: 'Remove any claim that cannot be traced to a source.',
    },
  ],
  build: [
    {
      title: 'Define the smallest outcome',
      action: 'State one user-visible result and the acceptance check for it.',
      doneWhen: 'The outcome fits in one sentence and has a testable check.',
      verification: 'Run the acceptance check against the current baseline.',
    },
    {
      title: 'Map the existing surface',
      action: 'Read the relevant code, config, and tests before changing anything.',
      doneWhen: 'Ownership and the smallest safe edit point are identified.',
      verification: 'A focused test fails or passes for the expected reason.',
    },
    {
      title: 'Implement the minimal change',
      action: 'Make the smallest coherent edit, keeping existing conventions.',
      doneWhen: 'The change is reviewable in one sitting and has a test.',
      verification: 'Run the focused test, typecheck, and lint.',
    },
    {
      title: 'Verify the real contract',
      action: 'Exercise the user-visible path, not only the unit seam.',
      doneWhen: 'The acceptance check passes end to end.',
      verification: 'Repeat the check from a clean state or fresh process.',
    },
    {
      title: 'Document and ship',
      action: 'Update the changelog and the one document a user will read.',
      doneWhen: 'Docs match behavior and the rollback path is known.',
      verification: 'Review the diff for unrelated changes before commit.',
    },
  ],
  write: [
    {
      title: 'Lock the reader and promise',
      action: 'Name the reader, the one takeaway, and the action they should take.',
      doneWhen: 'The promise fits in one sentence.',
      verification: 'A reader can restate the promise after one read.',
    },
    {
      title: 'Outline before prose',
      action: 'Order the argument as claim, evidence, objection, resolution.',
      doneWhen: 'Every section has one job.',
      verification: 'Delete any section that does not advance the promise.',
    },
    {
      title: 'Draft without polishing',
      action: 'Write the complete draft, marking unknowns instead of guessing.',
      doneWhen: 'The draft covers the outline end to end.',
      verification: 'Every factual claim has a source or a TODO.',
    },
    {
      title: 'Edit for truth, then clarity',
      action: 'Cut unsupported claims, then shorten sentences and remove filler.',
      doneWhen: 'No claim is stronger than its evidence.',
      verification: 'Read aloud; fix every place you stumble.',
    },
    {
      title: 'Publish and record',
      action: 'Publish to the agreed channel and store the canonical copy locally.',
      doneWhen: 'The link and version are recorded.',
      verification: 'Open the published copy and check formatting.',
    },
  ],
  analyze: [
    {
      title: 'State the decision and baseline',
      action: 'Write what the analysis will change and the current baseline number.',
      doneWhen: 'The baseline is measured, not assumed.',
      verification: 'Re-measure the baseline once with the same method.',
    },
    {
      title: 'Define evidence and failure modes',
      action: 'List the signals that would confirm or refute the hypothesis.',
      doneWhen: 'Each signal has a threshold and a data source.',
      verification: 'Try to name a result that would prove the analysis wrong.',
    },
    {
      title: 'Measure and separate causes',
      action: 'Collect the smallest dataset that answers the question; isolate one variable at a time.',
      doneWhen: 'Confounders and missing data are disclosed.',
      verification: 'Repeat the measurement or rerun the query.',
    },
    {
      title: 'Report with uncertainty',
      action: 'Lead with the finding, then evidence, limits, and the next check.',
      doneWhen: 'Confidence and error bars or ranges are explicit.',
      verification: 'A reviewer can reproduce the result from the notes.',
    },
  ],
  organize: [
    {
      title: 'Capture everything open',
      action: 'List current commitments, loose items, and deadlines in one place.',
      doneWhen: 'Nothing is tracked only in memory.',
      verification: 'Compare against the last three days of messages and notes.',
    },
    {
      title: 'Decide what matters',
      action: 'Rank by consequence and deadline; mark what can be dropped.',
      doneWhen: 'Each item is keep, defer, delegate, or drop.',
      verification: 'Check that the top three fit the available time.',
    },
    {
      title: 'Place work in time',
      action: 'Block the top items on a calendar with buffers.',
      doneWhen: 'Every must-do item has a start time.',
      verification: 'Walk the week once for conflicts and overcommitment.',
    },
    {
      title: 'Close the loop',
      action: 'Schedule a short review and a place to capture new items.',
      doneWhen: 'The review and inbox are on the calendar.',
      verification: 'After one day, confirm new items landed in the inbox.',
    },
  ],
  learn: [
    {
      title: 'Define the demonstrable skill',
      action: 'Write one task you will be able to do without help.',
      doneWhen: 'The task has a visible output.',
      verification: 'Attempt the task once to establish the baseline.',
    },
    {
      title: 'Choose the smallest curriculum',
      action: 'Pick one primary source and two practice exercises per concept.',
      doneWhen: 'The source list is short enough to finish.',
      verification: 'Schedule the first session before adding more material.',
    },
    {
      title: 'Practice with feedback',
      action: 'Do the exercise, compare with a worked example, and record the gap.',
      doneWhen: 'Each session ends with one corrected mistake.',
      verification: 'Redo the exercise from scratch the next day.',
    },
    {
      title: 'Prove transfer',
      action: 'Apply the skill to a new, unfamiliar task.',
      doneWhen: 'The new task is completed without step-by-step guidance.',
      verification: 'Ask someone to review the output, or use a rubric.',
    },
  ],
};

/**
 * Deterministic plan scaffold. It does not call a model and does not execute
 * anything; it turns an objective into reviewable steps with explicit
 * completion and verification criteria.
 */
export function createPlan(input: PlanInput): PlanResult {
  const objective = typeof input.objective === 'string' ? input.objective.trim() : '';
  if (!objective) throw new IntelligenceInputError('objective must be a non-empty string');
  if (objective.length > 2000) throw new IntelligenceInputError('objective is too long (max 2000 chars)');
  const constraints = normalizeList(input.constraints, 20, 300);
  const context = typeof input.context === 'string' ? input.context.trim().slice(0, 2000) : '';
  const deadline = typeof input.deadline === 'string' ? input.deadline.trim() : '';
  const category = classify(objective);
  const template = category === 'generic' ? genericTemplate(objective) : TEMPLATES[category];
  const steps = template.map((step, index) => ({
    ...step,
    id: `step-${String(index + 1).padStart(2, '0')}`,
  }));
  const risks = planRisks(objective, constraints, deadline);
  const assumptions = [
    'The owner reviews and approves the plan before any step runs.',
    'No step is executed automatically by this subsystem.',
  ];
  if (constraints.length > 0) assumptions.push(`Constraints applied: ${constraints.join('; ')}.`);
  if (context) assumptions.push('Context supplied by the owner is treated as unverified input.');

  const id = hashObject({ objective, category, constraints, deadline, context }).slice(0, 16);
  return {
    id,
    objective,
    category,
    steps,
    assumptions,
    risks,
    disclosures: [
      'Advisory plan only: it is a deterministic scaffold, not an executed workflow.',
      'Validate each step against the real environment before acting.',
    ],
  };
}

export function planResult(plan: PlanResult): DomainResult {
  const stepLines = plan.steps.map((step) => `${step.id} ${step.title}: ${step.action} Done when: ${step.doneWhen}`);
  return {
    answer:
      `Plan for: ${plan.objective}\n\n` +
      `${stepLines.join('\n')}\n\n` +
      'Verification: complete each step only when its stated done-when check passes; ' +
      'review the whole plan with the owner before executing anything.',
    verification: 'advisory',
    confidence: 0.6,
    evidence: [
      {
        kind: 'plan',
        label: `Deterministic ${plan.category} plan`,
        value: { id: plan.id, steps: plan.steps.length, category: plan.category },
        sha256: sha256(JSON.stringify(plan)),
      },
    ],
    disclosures: plan.disclosures,
    data: plan as unknown as Record<string, unknown>,
  };
}

function classify(objective: string): PlanCategory {
  const lower = objective.toLowerCase();
  let best: { category: PlanCategory; score: number; position: number } = {
    category: 'generic',
    score: 0,
    position: Number.POSITIVE_INFINITY,
  };
  for (const entry of CATEGORY_KEYWORDS) {
    let score = 0;
    let earliest = Number.POSITIVE_INFINITY;
    for (const term of entry.terms) {
      const index = lower.indexOf(term);
      if (index < 0) continue;
      score += term.includes(' ') ? 2 : 1;
      earliest = Math.min(earliest, index);
    }
    if (score === 0) continue;
    if (score > best.score || (score === best.score && earliest < best.position)) {
      best = { category: entry.category, score, position: earliest };
    }
  }
  return best.category;
}

function genericTemplate(objective: string): Array<Omit<PlanStep, 'id'>> {
  const focus = clip(objective, 140);
  return [
    {
      title: 'Clarify the outcome',
      action: `Restate the desired result for "${focus}" in one testable sentence.`,
      doneWhen: 'Success is observable without asking what was meant.',
      verification: 'Owner confirms the success check.',
    },
    {
      title: 'Find the smallest first step',
      action: 'Identify the action that reduces the most uncertainty with the least cost.',
      doneWhen: 'One next action is chosen and scheduled.',
      verification: 'The action produces evidence, not only activity.',
    },
    {
      title: 'Do and observe',
      action: 'Perform the step and record what happened, including surprises.',
      doneWhen: 'The result is written down.',
      verification: 'Compare the result with the success check.',
    },
    {
      title: 'Adjust and finish',
      action: 'Change one variable based on the observation, then complete or stop.',
      doneWhen: 'The success check passes or the stop condition is met.',
      verification: 'Record the final state and the reason for stopping.',
    },
  ];
}

function planRisks(objective: string, constraints: string[], deadline: string): string[] {
  const risks: string[] = [];
  if (objective.split(/\s+/).filter(Boolean).length < 5) {
    risks.push('The objective is very short; scope may be ambiguous.');
  }
  if (/(something|stuff|things|etc\.?|whatever)/i.test(objective)) {
    risks.push('The objective contains vague placeholders; replace them with concrete nouns.');
  }
  if (constraints.length === 0) {
    risks.push('No constraints were supplied; time, budget, and access limits are unknown.');
  }
  if (deadline) {
    const parsed = Date.parse(deadline);
    if (Number.isNaN(parsed)) risks.push('The deadline is not a parseable date.');
    else if (parsed < Date.now()) risks.push('The deadline is in the past.');
  } else {
    risks.push('No deadline was supplied; the plan has no urgency signal.');
  }
  return risks;
}

function normalizeList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((item) => item.slice(0, maxLength));
}
