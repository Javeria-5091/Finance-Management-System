'use client'

import { useState, useEffect, useCallback } from 'react'
import { Plus, Search, Eye, Edit2, Trash2, ChevronLeft, ChevronRight, Filter, CheckCircle, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import StatusBadge from '../ui/StatusBadge'
import { formatPKR, formatDate, formatPeriod, timeAgo } from '@/lib/helpers'
import EmployeeDialog from './EmployeeDialog'
import PayrollRunDetail from './PayrollRunDetail'

interface Department {
  id: string
  name: string
  code: string
}

interface Employee {
  id: string
  employeeCode: string
  name: string
  email: string | null
  phone: string | null
  designation: string | null
  employmentType: string
  status: string
  joinDate: string | null
  department: { id: string; name: string; code: string } | null
}

interface PayrollRun {
  id: string
  payrollPeriod: string
  status: string
  totalGrossPay: number
  totalNetPay: number
  totalDeductions: number
  totalEmployees: number
  createdAt: string
  _count: { payrollLines: number }
}

interface Advance {
  id: string
  amount: number
  remainingBalance: number
  purpose: string | null
  requestDate: string
  approvalStatus: string
  employee: { id: string; name: string; employeeCode: string; department: { id: string; name: string; code: string } | null }
}

interface Commission {
  id: string
  commissionType: string
  description: string | null
  baseAmount: number
  commissionRate: number
  commissionAmount: number
  periodMonth: string | null
  status: string
  employee: { id: string; name: string; employeeCode: string; department: { id: string; name: string; code: string } | null }
}

export default function PayrollPage() {
  const [departments, setDepartments] = useState<Department[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [runs, setRuns] = useState<PayrollRun[]>([])
  const [advances, setAdvances] = useState<Advance[]>([])
  const [commissions, setCommissions] = useState<Commission[]>([])
  const [activeTab, setActiveTab] = useState('employees')

  // Loading states
  const [empLoading, setEmpLoading] = useState(true)
  const [runsLoading, setRunsLoading] = useState(true)
  const [advLoading, setAdvLoading] = useState(true)
  const [commLoading, setCommLoading] = useState(true)

  // Filters
  const [empSearch, setEmpSearch] = useState('')
  const [empPage, setEmpPage] = useState(1)
  const [empTotalPages, setEmpTotalPages] = useState(1)
  const [runPage, setRunPage] = useState(1)
  const [runTotalPages, setRunTotalPages] = useState(1)

  // Dialog states
  const [showEmpDialog, setShowEmpDialog] = useState(false)
  const [editEmp, setEditEmp] = useState<Employee | null>(null)
  const [showRunDialog, setShowRunDialog] = useState(false)
  const [showAdvanceDialog, setShowAdvanceDialog] = useState(false)
  const [showCommDialog, setShowCommDialog] = useState(false)
  const [detailRunId, setDetailRunId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  // Run dialog form
  const [runForm, setRunForm] = useState({ month: String(new Date().getMonth() + 1), year: String(new Date().getFullYear()) })

  // Advance form
  const [advForm, setAdvForm] = useState({ employeeId: '', amount: '', purpose: '', monthlyDeduction: '', startDeductionMonth: '' })

  // Commission form
  const [commForm, setCommForm] = useState({ employeeId: '', commissionType: 'performance_based', baseAmount: '', commissionRate: '', commissionAmount: '', periodMonth: '', description: '' })

  // Fetch departments
  const fetchDepartments = useCallback(async () => {
    const res = await fetch('/api/departments?limit=50')
    const json = await res.json()
    setDepartments(json.data || [])
  }, [])

  // Fetch employees
  const fetchEmployees = useCallback(async () => {
    setEmpLoading(true)
    try {
      const params = new URLSearchParams({ page: String(empPage), limit: '10' })
      if (empSearch) params.set('search', empSearch)
      const res = await fetch(`/api/payroll/employees?${params}`)
      const json = await res.json()
      setEmployees(json.employees || [])
      setEmpTotalPages(json.pagination?.totalPages || 1)
    } catch { /* empty */ } finally { setEmpLoading(false) }
  }, [empPage, empSearch, refreshKey])

  // Fetch runs
  const fetchRuns = useCallback(async () => {
    setRunsLoading(true)
    try {
      const res = await fetch(`/api/payroll/runs?page=${runPage}&limit=10`)
      const json = await res.json()
      setRuns(json.runs || [])
      setRunTotalPages(json.pagination?.totalPages || 1)
    } catch { /* empty */ } finally { setRunsLoading(false) }
  }, [runPage, refreshKey])

  // Fetch advances
  const fetchAdvances = useCallback(async () => {
    setAdvLoading(true)
    try {
      const res = await fetch('/api/payroll/advances?limit=20')
      const json = await res.json()
      setAdvances(json.advances || [])
    } catch { /* empty */ } finally { setAdvLoading(false) }
  }, [refreshKey])

  // Fetch commissions
  const fetchCommissions = useCallback(async () => {
    setCommLoading(true)
    try {
      const res = await fetch('/api/payroll/commissions?limit=20')
      const json = await res.json()
      setCommissions(json.commissions || [])
    } catch { /* empty */ } finally { setCommLoading(false) }
  }, [refreshKey])

  useEffect(() => { fetchDepartments() }, [fetchDepartments])
  useEffect(() => { if (activeTab === 'employees') fetchEmployees() }, [fetchEmployees, activeTab])
  useEffect(() => { if (activeTab === 'runs') fetchRuns() }, [fetchRuns, activeTab])
  useEffect(() => { if (activeTab === 'advances') fetchAdvances() }, [fetchAdvances, activeTab])
  useEffect(() => { if (activeTab === 'commissions') fetchCommissions() }, [fetchCommissions, activeTab])

  const handleCreateRun = async () => {
    const month = runForm.month.padStart(2, '0')
    const year = runForm.year
    const startDate = `${year}-${month}-01`
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate()
    const endDate = `${year}-${month}-${lastDay}`
    setSubmitting(true)
    try {
      const res = await fetch('/api/payroll/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ periodStartDate: startDate, periodEndDate: endDate }),
      })
      if (!res.ok) { const err = await res.json(); alert(err.error || 'Failed'); return }
      setShowRunDialog(false)
      setRefreshKey(k => k + 1)
    } catch { alert('Failed') } finally { setSubmitting(false) }
  }

  const handleCreateAdvance = async () => {
    if (!advForm.employeeId || !advForm.amount) return
    setSubmitting(true)
    try {
      const res = await fetch('/api/payroll/advances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeId: advForm.employeeId,
          amount: parseFloat(advForm.amount),
          purpose: advForm.purpose,
          monthlyDeduction: advForm.monthlyDeduction ? parseFloat(advForm.monthlyDeduction) : null,
          startDeductionMonth: advForm.startDeductionMonth || null,
        }),
      })
      if (!res.ok) { const err = await res.json(); alert(err.error || 'Failed'); return }
      setShowAdvanceDialog(false)
      setAdvForm({ employeeId: '', amount: '', purpose: '', monthlyDeduction: '', startDeductionMonth: '' })
      setRefreshKey(k => k + 1)
    } catch { alert('Failed') } finally { setSubmitting(false) }
  }

  const handleAdvanceAction = async (id: string, action: 'approved' | 'rejected') => {
    try {
      const res = await fetch(`/api/payroll/advances/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalStatus: action }),
      })
      if (!res.ok) { const err = await res.json(); alert(err.error || 'Failed'); return }
      setRefreshKey(k => k + 1)
    } catch { alert('Failed') }
  }

  const handleCreateCommission = async () => {
    if (!commForm.employeeId || !commForm.commissionAmount) return
    setSubmitting(true)
    try {
      const res = await fetch('/api/payroll/commissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeId: commForm.employeeId,
          commissionType: commForm.commissionType,
          baseAmount: commForm.baseAmount ? parseFloat(commForm.baseAmount) : 0,
          commissionRate: commForm.commissionRate ? parseFloat(commForm.commissionRate) : 0,
          commissionAmount: parseFloat(commForm.commissionAmount),
          periodMonth: commForm.periodMonth || null,
          description: commForm.description || null,
        }),
      })
      if (!res.ok) { const err = await res.json(); alert(err.error || 'Failed'); return }
      setShowCommDialog(false)
      setCommForm({ employeeId: '', commissionType: 'performance_based', baseAmount: '', commissionRate: '', commissionAmount: '', periodMonth: '', description: '' })
      setRefreshKey(k => k + 1)
    } catch { alert('Failed') } finally { setSubmitting(false) }
  }

  const months = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: new Date(2024, i).toLocaleString('en', { month: 'long' }) }))
  const years = [2024, 2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }))

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Payroll Management</h1>
        <p className="text-sm text-gray-500">Manage employees, payroll runs, advances, and commissions</p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="bg-gray-100">
          <TabsTrigger value="employees" className="text-sm">Employees</TabsTrigger>
          <TabsTrigger value="runs" className="text-sm">Payroll Runs</TabsTrigger>
          <TabsTrigger value="advances" className="text-sm">Advances</TabsTrigger>
          <TabsTrigger value="commissions" className="text-sm">Commissions</TabsTrigger>
        </TabsList>

        {/* ========== EMPLOYEES TAB ========== */}
        <TabsContent value="employees" className="space-y-4 mt-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input placeholder="Search employees..." value={empSearch} onChange={e => { setEmpSearch(e.target.value); setEmpPage(1) }} className="pl-9" />
            </div>
            <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => { setEditEmp(null); setShowEmpDialog(true) }}>
              <Plus className="h-4 w-4 mr-2" /> Add Employee
            </Button>
          </div>

          <Card>
            <CardContent className="p-0">
              {empLoading ? (
                <div className="p-4 space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
              ) : !employees.length ? (
                <div className="text-center py-12"><p className="text-gray-500 text-sm">No employees found</p></div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Code</TableHead>
                        <TableHead className="text-xs">Name</TableHead>
                        <TableHead className="text-xs hidden md:table-cell">Designation</TableHead>
                        <TableHead className="text-xs hidden sm:table-cell">Department</TableHead>
                        <TableHead className="text-xs">Type</TableHead>
                        <TableHead className="text-xs">Status</TableHead>
                        <TableHead className="text-xs text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {employees.map((emp) => (
                        <TableRow key={emp.id}>
                          <TableCell className="text-xs font-mono">{emp.employeeCode}</TableCell>
                          <TableCell className="text-xs font-medium">{emp.name}</TableCell>
                          <TableCell className="text-xs text-gray-500 hidden md:table-cell">{emp.designation || '—'}</TableCell>
                          <TableCell className="text-xs text-gray-500 hidden sm:table-cell">{emp.department?.name || '—'}</TableCell>
                          <TableCell className="text-xs capitalize">{emp.employmentType.replace(/_/g, ' ')}</TableCell>
                          <TableCell><StatusBadge status={emp.status} /></TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditEmp(emp); setShowEmpDialog(true) }}><Edit2 className="h-3.5 w-3.5" /></Button>
                              <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500" onClick={async () => {
                                if (!confirm(`Terminate ${emp.name}?`)) return
                                await fetch(`/api/payroll/employees/${emp.id}`, { method: 'DELETE' })
                                setRefreshKey(k => k + 1)
                              }}><Trash2 className="h-3.5 w-3.5" /></Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {empTotalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500">Page {empPage} of {empTotalPages}</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={empPage <= 1} onClick={() => setEmpPage(p => p - 1)}><ChevronLeft className="h-4 w-4" /></Button>
                <Button variant="outline" size="sm" disabled={empPage >= empTotalPages} onClick={() => setEmpPage(p => p + 1)}><ChevronRight className="h-4 w-4" /></Button>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ========== PAYROLL RUNS TAB ========== */}
        <TabsContent value="runs" className="space-y-4 mt-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500">Create and manage payroll runs</p>
            <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => setShowRunDialog(true)}>
              <Plus className="h-4 w-4 mr-2" /> Create Payroll Run
            </Button>
          </div>

          <Card>
            <CardContent className="p-0">
              {runsLoading ? (
                <div className="p-4 space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
              ) : !runs.length ? (
                <div className="text-center py-12"><p className="text-gray-500 text-sm">No payroll runs yet</p></div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Period</TableHead>
                        <TableHead className="text-xs">Status</TableHead>
                        <TableHead className="text-xs text-right">Total Gross</TableHead>
                        <TableHead className="text-xs text-right">Total Net</TableHead>
                        <TableHead className="text-xs text-center">Employees</TableHead>
                        <TableHead className="text-xs">Created</TableHead>
                        <TableHead className="text-xs text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {runs.map((run) => (
                        <TableRow key={run.id}>
                          <TableCell className="text-xs font-medium">{formatPeriod(run.payrollPeriod)}</TableCell>
                          <TableCell><StatusBadge status={run.status} /></TableCell>
                          <TableCell className="text-xs text-right">{formatPKR(run.totalGrossPay)}</TableCell>
                          <TableCell className="text-xs text-right font-medium">{formatPKR(run.totalNetPay)}</TableCell>
                          <TableCell className="text-xs text-center">{run.totalEmployees}</TableCell>
                          <TableCell className="text-xs text-gray-500">{timeAgo(run.createdAt)}</TableCell>
                          <TableCell className="text-right">
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setDetailRunId(run.id)}><Eye className="h-3.5 w-3.5" /></Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {runTotalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500">Page {runPage} of {runTotalPages}</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={runPage <= 1} onClick={() => setRunPage(p => p - 1)}><ChevronLeft className="h-4 w-4" /></Button>
                <Button variant="outline" size="sm" disabled={runPage >= runTotalPages} onClick={() => setRunPage(p => p + 1)}><ChevronRight className="h-4 w-4" /></Button>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ========== ADVANCES TAB ========== */}
        <TabsContent value="advances" className="space-y-4 mt-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500">Manage salary advance requests</p>
            <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => setShowAdvanceDialog(true)}>
              <Plus className="h-4 w-4 mr-2" /> New Advance
            </Button>
          </div>

          <Card>
            <CardContent className="p-0">
              {advLoading ? (
                <div className="p-4 space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
              ) : !advances.length ? (
                <div className="text-center py-12"><p className="text-gray-500 text-sm">No advances recorded</p></div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Employee</TableHead>
                        <TableHead className="text-xs">Purpose</TableHead>
                        <TableHead className="text-xs text-right">Amount</TableHead>
                        <TableHead className="text-xs text-right">Remaining</TableHead>
                        <TableHead className="text-xs">Status</TableHead>
                        <TableHead className="text-xs">Date</TableHead>
                        <TableHead className="text-xs text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {advances.map((adv) => (
                        <TableRow key={adv.id}>
                          <TableCell className="text-xs font-medium">{adv.employee.name}</TableCell>
                          <TableCell className="text-xs text-gray-500">{adv.purpose || '—'}</TableCell>
                          <TableCell className="text-xs text-right">{formatPKR(adv.amount)}</TableCell>
                          <TableCell className="text-xs text-right font-medium">{formatPKR(adv.remainingBalance)}</TableCell>
                          <TableCell><StatusBadge status={adv.approvalStatus} /></TableCell>
                          <TableCell className="text-xs text-gray-500">{formatDate(adv.requestDate)}</TableCell>
                          <TableCell className="text-right">
                            {adv.approvalStatus === 'pending' && (
                              <div className="flex items-center justify-end gap-1">
                                <Button variant="ghost" size="icon" className="h-7 w-7 text-emerald-600" onClick={() => handleAdvanceAction(adv.id, 'approved')}><CheckCircle className="h-3.5 w-3.5" /></Button>
                                <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500" onClick={() => handleAdvanceAction(adv.id, 'rejected')}><XCircle className="h-3.5 w-3.5" /></Button>
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ========== COMMISSIONS TAB ========== */}
        <TabsContent value="commissions" className="space-y-4 mt-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500">Track employee commissions</p>
            <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => setShowCommDialog(true)}>
              <Plus className="h-4 w-4 mr-2" /> Add Commission
            </Button>
          </div>

          <Card>
            <CardContent className="p-0">
              {commLoading ? (
                <div className="p-4 space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
              ) : !commissions.length ? (
                <div className="text-center py-12"><p className="text-gray-500 text-sm">No commissions recorded</p></div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Employee</TableHead>
                        <TableHead className="text-xs">Type</TableHead>
                        <TableHead className="text-xs text-right">Base Amount</TableHead>
                        <TableHead className="text-xs text-right">Rate</TableHead>
                        <TableHead className="text-xs text-right">Commission</TableHead>
                        <TableHead className="text-xs">Period</TableHead>
                        <TableHead className="text-xs">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {commissions.map((comm) => (
                        <TableRow key={comm.id}>
                          <TableCell className="text-xs font-medium">{comm.employee.name}</TableCell>
                          <TableCell className="text-xs capitalize">{comm.commissionType.replace(/_/g, ' ')}</TableCell>
                          <TableCell className="text-xs text-right">{formatPKR(comm.baseAmount)}</TableCell>
                          <TableCell className="text-xs text-right">{comm.commissionRate}%</TableCell>
                          <TableCell className="text-xs text-right font-medium">{formatPKR(comm.commissionAmount)}</TableCell>
                          <TableCell className="text-xs text-gray-500">{comm.periodMonth ? formatPeriod(comm.periodMonth) : '—'}</TableCell>
                          <TableCell><StatusBadge status={comm.status} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Employee Dialog */}
      <EmployeeDialog
        open={showEmpDialog}
        employee={editEmp}
        departments={departments}
        onClose={() => { setShowEmpDialog(false); setEditEmp(null) }}
        onSaved={() => setRefreshKey(k => k + 1)}
      />

      {/* Create Payroll Run Dialog */}
      <Dialog open={showRunDialog} onOpenChange={o => { if (!o) setShowRunDialog(false) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Create Payroll Run</DialogTitle>
            <DialogDescription>Select the period for the payroll run</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-3">
            <div className="grid gap-2">
              <Label>Month</Label>
              <Select value={runForm.month} onValueChange={v => setRunForm(f => ({ ...f, month: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{months.map(m => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Year</Label>
              <Select value={runForm.year} onValueChange={v => setRunForm(f => ({ ...f, year: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{years.map(y => <SelectItem key={y.value} value={y.value}>{y.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRunDialog(false)}>Cancel</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={handleCreateRun} disabled={submitting}>
              {submitting ? 'Creating...' : 'Create Run'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Advance Dialog */}
      <Dialog open={showAdvanceDialog} onOpenChange={o => { if (!o) setShowAdvanceDialog(false) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Advance Request</DialogTitle>
            <DialogDescription>Create a salary advance for an employee</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-3">
            <div className="grid gap-2">
              <Label>Employee *</Label>
              <Select value={advForm.employeeId} onValueChange={v => setAdvForm(f => ({ ...f, employeeId: v }))}>
                <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
                <SelectContent>{employees.filter(e => e.status === 'active').map(e => <SelectItem key={e.id} value={e.id}>{e.name} ({e.employeeCode})</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Amount (PKR) *</Label>
                <Input type="number" value={advForm.amount} onChange={e => setAdvForm(f => ({ ...f, amount: e.target.value }))} placeholder="0" />
              </div>
              <div className="grid gap-2">
                <Label>Monthly Deduction</Label>
                <Input type="number" value={advForm.monthlyDeduction} onChange={e => setAdvForm(f => ({ ...f, monthlyDeduction: e.target.value }))} placeholder="0" />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Purpose</Label>
              <Textarea value={advForm.purpose} onChange={e => setAdvForm(f => ({ ...f, purpose: e.target.value }))} placeholder="Reason for advance..." rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdvanceDialog(false)}>Cancel</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={handleCreateAdvance} disabled={submitting || !advForm.employeeId || !advForm.amount}>
              {submitting ? 'Creating...' : 'Create Advance'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Commission Dialog */}
      <Dialog open={showCommDialog} onOpenChange={o => { if (!o) setShowCommDialog(false) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Commission</DialogTitle>
            <DialogDescription>Record a commission entry for an employee</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-3">
            <div className="grid gap-2">
              <Label>Employee *</Label>
              <Select value={commForm.employeeId} onValueChange={v => setCommForm(f => ({ ...f, employeeId: v }))}>
                <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
                <SelectContent>{employees.filter(e => e.status === 'active').map(e => <SelectItem key={e.id} value={e.id}>{e.name} ({e.employeeCode})</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Commission Type</Label>
                <Select value={commForm.commissionType} onValueChange={v => setCommForm(f => ({ ...f, commissionType: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="project_based">Project Based</SelectItem>
                    <SelectItem value="sales_based">Sales Based</SelectItem>
                    <SelectItem value="performance_based">Performance Based</SelectItem>
                    <SelectItem value="referral">Referral</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Period</Label>
                <Input value={commForm.periodMonth} onChange={e => setCommForm(f => ({ ...f, periodMonth: e.target.value }))} placeholder="2026-07" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Base Amount</Label>
                <Input type="number" value={commForm.baseAmount} onChange={e => setCommForm(f => ({ ...f, baseAmount: e.target.value }))} placeholder="0" />
              </div>
              <div className="grid gap-2">
                <Label>Rate (%)</Label>
                <Input type="number" value={commForm.commissionRate} onChange={e => setCommForm(f => ({ ...f, commissionRate: e.target.value }))} placeholder="0" />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Commission Amount (PKR) *</Label>
              <Input type="number" value={commForm.commissionAmount} onChange={e => setCommForm(f => ({ ...f, commissionAmount: e.target.value }))} placeholder="0" />
            </div>
            <div className="grid gap-2">
              <Label>Description</Label>
              <Textarea value={commForm.description} onChange={e => setCommForm(f => ({ ...f, description: e.target.value }))} placeholder="Commission details..." rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCommDialog(false)}>Cancel</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={handleCreateCommission} disabled={submitting || !commForm.employeeId || !commForm.commissionAmount}>
              {submitting ? 'Creating...' : 'Add Commission'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Payroll Run Detail Sheet */}
      <PayrollRunDetail
        runId={detailRunId}
        open={!!detailRunId}
        onClose={() => setDetailRunId(null)}
        onRefresh={() => setRefreshKey(k => k + 1)}
      />
    </div>
  )
}
