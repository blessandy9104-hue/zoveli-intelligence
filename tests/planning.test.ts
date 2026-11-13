import { describe, expect, it } from 'vitest';
import { createPlan, planResult } from '../src/domains/planning.js';
import { IntelligenceInputError } from '../src/errors.js';

describe('deterministic planning', () => {
  it('builds a reviewable build plan with verification criteria', () => {
    const plan = createPlan({
      objective: 'Build a local search feature for my notes app',
      constraints: ['No network access', 'Ship in one week'],
      deadline: '2099-01-01',
      context: 'TypeScript monorepo',
    });

    expect(plan.category).toBe('build');
    expect(plan.steps).toHaveLength(5);
    expect(plan.steps.map((step) => step.id)).toEqual([
      'step-01', 'step-02', 'step-03', 'step-04', 'step-05',
    ]);
    for (const step of plan.steps) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.action.length).toBeGreaterThan(0);
      expect(step.doneWhen.length).toBeGreaterThan(0);
      expect(step.verification.length).toBeGreaterThan(0);
    }
    expect(plan.assumptions.join(' ')).toContain('No network access');
    expect(plan.disclosures.join(' ')).toContain('Advisory plan only');
    expect(plan.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('classifies common objective categories', () => {
    expect(createPlan({ objective: 'Research the best local database options' }).category).toBe('research');
    expect(createPlan({ objective: 'Write a launch announcement for the blog' }).category).toBe('write');
    expect(createPlan({ objective: 'Analyze last month performance metrics' }).category).toBe('analyze');
    expect(createPlan({ objective: 'Organize my travel itinerary' }).category).toBe('organize');
    expect(createPlan({ objective: 'Learn enough Rust to build a CLI' }).category).toBe('learn');
    expect(createPlan({ objective: 'xyzzy plugh' }).category).toBe('generic');
  });

  it('is deterministic for the same objective', () => {
    const input = { objective: 'Build a daily review habit' };
    expect(createPlan(input).id).toBe(createPlan(input).id);
    expect(JSON.stringify(createPlan(input))).toBe(JSON.stringify(createPlan(input)));
  });

  it('flags missing and invalid constraints and deadlines', () => {
    const noLimits = createPlan({ objective: 'Do a thing' });
    expect(noLimits.risks.join(' ')).toContain('No constraints');
    expect(noLimits.risks.join(' ')).toContain('No deadline');

    const invalid = createPlan({ objective: 'Prepare a report', deadline: 'not-a-date' });
    expect(invalid.risks.join(' ')).toContain('not a parseable date');

    const past = createPlan({ objective: 'Prepare a report', deadline: '2000-01-01' });
    expect(past.risks.join(' ')).toContain('in the past');

    const vague = createPlan({ objective: 'Do some stuff' });
    expect(vague.risks.join(' ')).toContain('vague placeholders');
  });

  it('keeps the overall verification statement general', () => {
    const plan = createPlan({ objective: 'Build a local search feature' });
    const result = planResult(plan);

    expect(result.verification).toBe('advisory');
    expect(result.answer).toContain('Verification: complete each step');
    expect(result.answer).toContain(plan.steps[0].title);
    expect(result.answer).toContain(plan.steps.at(-1)?.title ?? '');
    expect(result.evidence[0].kind).toBe('plan');
    expect(result.evidence[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.data?.id).toBe(plan.id);
  });

  it('rejects empty or oversized objectives', () => {
    expect(() => createPlan({ objective: '' })).toThrow(IntelligenceInputError);
    expect(() => createPlan({ objective: '   ' })).toThrow(IntelligenceInputError);
    expect(() => createPlan({ objective: 'x'.repeat(2001) })).toThrow(IntelligenceInputError);
  });

  it('caps very long constraint lists', () => {
    const constraints = Array.from({ length: 30 }, (_, index) => `constraint-${index}`);
    const plan = createPlan({ objective: 'Build something small', constraints });
    const assumption = plan.assumptions.find((entry) => entry.startsWith('Constraints applied'));
    expect(assumption).toContain('constraint-0');
    expect(assumption).toContain('constraint-19');
    expect(assumption).not.toContain('constraint-20');
  });
});
