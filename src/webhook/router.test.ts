import { describe, expect, it } from 'vitest';
import { extractBriefArgsFromText, extractCompanyFromText } from './router.js';

describe('intent parsing', () => {
  it('extracts company and role from natural language brief request', () => {
    const parsed = extractBriefArgsFromText('Brief me about company Google for role Software Engineer');
    expect(parsed).toEqual({ company: 'Google', role: 'Software Engineer' });
  });

  it('extracts company without explicit role', () => {
    const parsed = extractBriefArgsFromText('brief me about Google');
    expect(parsed).toEqual({ company: 'Google', role: null });
  });

  it('extracts company for /company intent', () => {
    const company = extractCompanyFromText('Tell me about company Stripe.');
    expect(company).toBe('Stripe');
  });
});
