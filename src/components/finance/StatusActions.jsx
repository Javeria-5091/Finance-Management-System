'use client';

import { usePermissions } from '@/context/PermissionContext';
import { useAuth } from '@/context/AuthContext';
import { Pencil, Trash2, Send, CheckCircle, RotateCcw, XCircle, Loader2 } from 'lucide-react';

export default function StatusActions({ record, module, onAction, isPosting }) {
  const { hasPermission, role } = usePermissions();
  const { user } = useAuth();
  
  const mod = module.toUpperCase();
  const status = record.status;
  const isCreator = record.created_by === user?.id || record.user_id === user?.id;
  const actions = [];

  // ═══════════════════════════════════════════════════════
  // DRAFT: edit, delete, submit
  // ═══════════════════════════════════════════════════════
  if (status === 'DRAFT') {
    if (isCreator && hasPermission(`${mod}_UPDATE`)) actions.push({ key: 'edit', label: 'Edit', icon: Pencil, variant: 'secondary' });
    if (isCreator && hasPermission(`${mod}_DELETE`)) actions.push({ key: 'delete', label: 'Delete', icon: Trash2, variant: 'danger' });
    if (hasPermission(`${mod}_UPDATE`)) actions.push({ key: 'submit', label: 'Submit', icon: Send, variant: 'primary' });
  }

  // ═══════════════════════════════════════════════════════
  // SUBMITTED: verify (not creator), approve (not creator), reject
  // ═══════════════════════════════════════════════════════
  if (status === 'SUBMITTED') {
    if (hasPermission(`APPROVE_${mod}`) && !isCreator) actions.push({ key: 'verify', label: 'Verify', icon: CheckCircle, variant: 'primary' });
    if (hasPermission(`APPROVE_${mod}`) && !isCreator) actions.push({ key: 'approve', label: 'Approve', icon: CheckCircle, variant: 'primary' });
    if (hasPermission(`${mod}_UPDATE`) || hasPermission('ADMIN_CONFIG')) actions.push({ key: 'reject', label: 'Reject', icon: XCircle, variant: 'danger', needsReason: true });
  }

  // ═══════════════════════════════════════════════════════
  // VERIFIED / APPROVED: approve (not creator), post
  // ═══════════════════════════════════════════════════════
  if (status === 'VERIFIED' || status === 'APPROVED') {
    if (status === 'VERIFIED' && hasPermission(`APPROVE_${mod}`) && !isCreator) 
      actions.push({ key: 'approve', label: 'Approve', icon: CheckCircle, variant: 'primary' });
    if (hasPermission(`${mod}_UPDATE`)) 
      actions.push({ key: 'post', label: 'Post', icon: CheckCircle, variant: 'success' });
  }

  // ═══════════════════════════════════════════════════════
  // POSTED: reverse
  // ═══════════════════════════════════════════════════════
  if (status === 'POSTED') {
    if (hasPermission(`${mod}_UPDATE`)) actions.push({ key: 'reverse', label: 'Reverse', icon: RotateCcw, variant: 'warning', needsReason: true });
  }

  // ═══════════════════════════════════════════════════════
  // REJECTED: reopen by creator only
  // ═══════════════════════════════════════════════════════
  if (status === 'REJECTED') {
    if (isCreator) actions.push({ key: 'reopen', label: 'Reopen', icon: RotateCcw, variant: 'secondary' });
  }

  const variantStyles = {
    primary: 'text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-500/10',
    success: 'text-green-600 hover:bg-green-50 dark:text-green-400 dark:hover:bg-green-500/10 bg-green-100 dark:bg-green-900/30',
    danger: 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10',
    secondary: 'text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700',
    warning: 'text-orange-600 hover:bg-orange-50 dark:text-orange-400 dark:hover:bg-orange-500/10'
  };

  return (
    <div className="flex items-center justify-end gap-1">
      {actions.map((action) => {
        const Icon = action.icon;
        const disabled = action.key === 'post' && isPosting;
        return action.key === 'post' ? (
          <button 
            key={action.key} 
            onClick={() => !disabled && onAction(action.key)} 
            title={action.label} 
            disabled={disabled}
            className={`flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md transition-colors ${variantStyles[action.variant]} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {disabled ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />} {action.label}
          </button>
        ) : (
          <button key={action.key} onClick={() => onAction(action.key, action.needsReason)} title={action.label} className={`p-1.5 rounded transition-colors ${variantStyles[action.variant]}`}>
            <Icon size={15} />
          </button>
        );
      })}
    </div>
  );
}