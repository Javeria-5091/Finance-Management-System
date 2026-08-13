// =============================================================================
// AI Suggestions Service — Spec 9.7/9.9
// Shared service for writing, reading, and managing AI suggestions.
// Used by: Transaction Coding, Duplicate Detection, Reconciliation Suggestions
//
// Spec 9.9: ai_suggestions table stores classification/reconciliation/anomaly
// suggestions with entity, suggestion type, confidence, and accepted/rejected status.
// =============================================================================

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export interface AiSuggestion {
  id?: string;
  user_id: string;
  organization_id: string;
  entity_type: string;
  entity_id?: string;
  suggestion_type: string;
  confidence: 'high' | 'medium' | 'low';
  suggestion_data: any;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  accepted_by?: string;
  accepted_at?: string;
  rejection_reason?: string;
  created_at?: string;
}

// =============================================================================
// CREATE SUGGESTION
// =============================================================================

export async function createSuggestion(
  supabase: any,
  suggestion: Omit<AiSuggestion, 'id' | 'created_at'>
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .schema('ai')
      .from('ai_suggestions')
      .insert(suggestion)
      .select('id')
      .single();

    if (error) {
      console.error('createSuggestion error:', error.message);
      return null;
    }
    return data?.id;
  } catch (error: any) {
    console.error('createSuggestion error:', error.message);
    return null;
  }
}

// =============================================================================
// GET SUGGESTIONS FOR ENTITY
// Fetch all pending/active suggestions for a given entity
// =============================================================================

export async function getSuggestionsForEntity(
  supabase: any,
  orgId: string,
  entityType: string,
  entityId?: string,
  status: string = 'pending'
): Promise<AiSuggestion[]> {
  try {
    let query = supabase
      .schema('ai')
      .from('ai_suggestions')
      .select('*')
      .eq('organization_id', orgId)
      .eq('entity_type', entityType)
      .eq('status', status)
      .order('created_at', { ascending: false });

    if (entityId) {
      query = query.eq('entity_id', entityId);
    }

    const { data, error } = await query.limit(20);

    if (error) {
      console.error('getSuggestionsForEntity error:', error.message);
      return [];
    }
    return (data || []) as AiSuggestion[];
  } catch (error: any) {
    console.error('getSuggestionsForEntity error:', error.message);
    return [];
  }
}

// =============================================================================
// ACCEPT SUGGESTION
// Spec 9.7: "Human approval required" — user explicitly accepts
// =============================================================================

export async function acceptSuggestion(
  supabase: any,
  suggestionId: string,
  acceptedBy: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase
      .schema('ai')
      .from('ai_suggestions')
      .update({
        status: 'accepted',
        accepted_by: acceptedBy,
        accepted_at: new Date().toISOString(),
      })
      .eq('id', suggestionId);

    if (error) {
      console.error('acceptSuggestion error:', error.message);
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (error: any) {
    console.error('acceptSuggestion error:', error.message);
    return { success: false, error: error.message };
  }
}

// =============================================================================
// REJECT SUGGESTION
// =============================================================================

export async function rejectSuggestion(
  supabase: any,
  suggestionId: string,
  userId: string,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase
      .schema('ai')
      .from('ai_suggestions')
      .update({
        status: 'rejected',
        rejection_reason: reason || null,
      })
      .eq('id', suggestionId);

    if (error) {
      console.error('rejectSuggestion error:', error.message);
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (error: any) {
    console.error('rejectSuggestion error:', error.message);
    return { success: false, error: error.message };
  }
}

// =============================================================================
// GET SUGGESTION STATS
// For dashboard/admin view of AI suggestion performance
// =============================================================================

export async function getSuggestionStats(
  supabase: any,
  orgId: string,
  dateFrom?: string,
  dateTo?: string
): Promise<{
  total: number;
  accepted: number;
  rejected: number;
  pending: number;
  expired: number;
  by_type: Record<string, { total: number; accepted: number; rejected: number }>;
}> {
  try {
    let query = supabase
      .schema('ai')
      .from('ai_suggestions')
      .select('id, status, suggestion_type')
      .eq('organization_id', orgId);

    if (dateFrom) query = query.gte('created_at', dateFrom);
    if (dateTo) query = query.lte('created_at', dateTo);

    const { data, error } = await query;

    if (error || !data) {
      return { total: 0, accepted: 0, rejected: 0, pending: 0, expired: 0, by_type: {} };
    }

    const stats = { total: data.length, accepted: 0, rejected: 0, pending: 0, expired: 0,
      by_type: {} as Record<string, { total: number; accepted: number; rejected: number }> };

    for (const row of data) {
      stats[row.status as keyof typeof stats] = (stats[row.status as keyof typeof stats] || 0) + 1;

      if (!stats.by_type[row.suggestion_type]) {
        stats.by_type[row.suggestion_type] = { total: 0, accepted: 0, rejected: 0 };
      }
      stats.by_type[row.suggestion_type].total++;
      if (row.status === 'accepted') stats.by_type[row.suggestion_type].accepted++;
      if (row.status === 'rejected') stats.by_type[row.suggestion_type].rejected++;
    }

    return stats;
  } catch (error: any) {
    console.error('getSuggestionStats error:', error.message);
    return { total: 0, accepted: 0, rejected: 0, pending: 0, expired: 0, by_type: {} };
  }
}

// =============================================================================
// EXPIRE OLD PENDING SUGGESTIONS
// Auto-expire suggestions older than 7 days (run via cron)
// =============================================================================

export async function expireOldSuggestions(
  supabase: any,
  orgId: string,
  maxAgeDays: number = 7
): Promise<number> {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);

    const { data, error } = await supabase
      .schema('ai')
      .from('ai_suggestions')
      .update({ status: 'expired' })
      .eq('organization_id', orgId)
      .eq('status', 'pending')
      .lt('created_at', cutoff.toISOString())
      .select('id');

    return data?.length || 0;
  } catch (error: any) {
    console.error('expireOldSuggestions error:', error.message);
    return 0;
  }
}