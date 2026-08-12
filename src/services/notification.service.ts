// FIX 8.4: notification service now uses correct schema.
// The notifications table lives in 'core' schema, not 'public'.
// Using .schema('core') explicitly to avoid ambiguity.

import { supabase } from '@/lib/supabase';
import { getAuthUser } from '@/lib/api-auth';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

function createDB() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: async () => (await cookies()).getAll(), setAll: () => {} } }
  );
}

export const notificationService = {
  // Create a notification for a specific user
  async create(params: {
    userId: string;
    title: string;
    message: string;
    type: 'APPROVAL_PENDING' | 'PAYMENT_DUE' | 'BUDGET_ALERT' | 'SYSTEM' | 'WORKFLOW' | 'REMINDER' | 'OVERDUE' | 'INFO' | 'BUDGET_CAUTION' | 'BUDGET_WARNING' | 'BUDGET_BLOCKED' | 'BUDGET_EXCEEDED';
    priority?: 'low' | 'medium' | 'high' | 'urgent' | 'info' | 'critical';
    actionUrl?: string;
    entityType?: string;
    entityId?: string;
    organizationId?: string;
    // FIX 8.4: Additional fields for budget alert notifications (Spec 13.4)
    recipientRoles?: string[];
    sourceEntityType?: string;
    sourceEntityId?: string;
    relatedEntityType?: string;
    relatedEntityId?: string;
    triggeredBy?: string;
    metadata?: any;
  }) {
    const db = createDB();
    // FIX 8.4: Use .schema('core') explicitly — table is in core schema
    const { data, error } = await db
      .schema('core')
      .from('notifications')
      .insert({
        user_id: params.userId,
        title: params.title,
        message: params.message,
        notification_type: params.type,
        priority: params.priority || 'medium',
        action_url: params.actionUrl || null,
        entity_type: params.entityType || null,
        entity_id: params.entityId || null,
        is_read: false,
        organization_id: params.organizationId || null,
        recipient_roles: params.recipientRoles || null,
        source_entity_type: params.sourceEntityType || null,
        source_entity_id: params.sourceEntityId || null,
        related_entity_type: params.relatedEntityType || null,
        related_entity_id: params.relatedEntityId || null,
        triggered_by: params.triggeredBy || null,
        metadata: params.metadata || null,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // Convenience: Notify approvers when item needs approval
  async notifyApprovers(params: {
    approverIds: string[];
    entityType: string;
    entityId: string;
    entityLabel: string;
    action: 'submit' | 'verify' | 'approve';
    organizationId?: string;
  }) {
    const typeMap: Record<string, string> = {
      submit: 'APPROVAL_PENDING',
      verify: 'WORKFLOW',
      approve: 'WORKFLOW',
    };

    const titleMap: Record<string, string> = {
      submit: `Pending Approval: ${params.entityLabel}`,
      verify: `Verification Needed: ${params.entityLabel}`,
      approve: `Approved: ${params.entityLabel}`,
    };

    for (const userId of params.approverIds) {
      try {
        await this.create({
          userId,
          title: titleMap[params.action] || `Action Required: ${params.entityLabel}`,
          message: `A ${params.entityType} (${params.entityLabel}) has been submitted and requires your ${params.action}.`,
          type: (typeMap[params.action] as any) || 'APPROVAL_PENDING',
          priority: params.action === 'submit' ? 'high' : 'medium',
          entityType: params.entityType,
          entityId: params.entityId,
          actionUrl: `/dashboard/${params.entityType}s/${params.entityId}`,
          organizationId: params.organizationId,
        });
      } catch (err) {
        console.error(`Failed to notify user ${userId}:`, err);
      }
    }
  },

  // Convenience: Budget alert notification
  async notifyBudgetAlert(params: {
    userId: string;
    budgetId: string;
    budgetLabel: string;
    utilization: number;
    remaining: number;
    organizationId?: string;
  }) {
    const priority = params.utilization >= 100 ? 'urgent' : params.utilization >= 90 ? 'high' : 'medium';

    await this.create({
      userId: params.userId,
      title: params.utilization >= 100 ? 'BUDGET EXCEEDED' : 'Budget Alert',
      message: `Budget "${params.budgetLabel}" is at ${params.utilization.toFixed(1)}% utilization. Remaining: PKR ${params.remaining.toLocaleString()}`,
      type: 'BUDGET_ALERT',
      priority: priority as any,
      entityType: 'budget',
      entityId: params.budgetId,
      organizationId: params.organizationId,
    });
  },

  // Get unread count for a user
  async getUnreadCount(userId: string): Promise<number> {
    const db = createDB();
    // FIX 8.4: Use .schema('core') explicitly
    const { count } = await db
      .schema('core')
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_read', false);
    return count || 0;
  },

  // Mark as read
  async markAsRead(notificationIds: string[], userId: string) {
    const db = createDB();
    const { error } = await db
      .schema('core')
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .in('id', notificationIds)
      .eq('user_id', userId);
    if (error) throw error;
  },

  // Mark all as read for a user
  async markAllAsRead(userId: string) {
    const db = createDB();
    const { error } = await db
      .schema('core')
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('is_read', false);
    if (error) throw error;
  },
};