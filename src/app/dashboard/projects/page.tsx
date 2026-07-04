"use client";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { Project, ProjectFormData } from "@/types";
import ProjectForm from "@/components/sections/ProjectForm";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { logAction } from "@/lib/logAction";

export default function ProjectsPage() {
  const { user, hasPermission } = useAuth();
  
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [formLoading, setFormLoading] = useState(false);
  
  const [showForm, setShowForm] = useState(false);
  const [editingData, setEditingData] = useState<Project | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // ✅ EXACT ALAG ALAG PERMISSIONS
  const canAdd = hasPermission("can_create_project");
  const canEdit = hasPermission("can_edit_project");
  const canDelete = hasPermission("can_delete_project");
  const showActions = canEdit || canDelete;

  const fetchProjects = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("projects")
      .select("*")
      .order("created_at", { ascending: false });
    if (data) setProjects(data);
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);

  async function handleSubmit(data: ProjectFormData) {
    setFormLoading(true);
    
    const safeData = {
      ...data,
      end_date: data.end_date === "" ? null : data.end_date
    };

    let error = null;
    if (editingData) {
      const res = await supabase.from("projects").update(safeData).eq("id", editingData.id);
      error = res.error;
      if(!error && user) await logAction(user.id, "Project Updated", "Project", `Updated project: ${safeData.name}`);
    } else {
      const res = await supabase.from("projects").insert({ ...safeData, user_id: user?.id });
      error = res.error;
      if(!error && user) await logAction(user.id, "Project Created", "Project", `Created project: ${safeData.name}`);
    }

    if (error) {
      alert("Database Error: " + error.message);
    } else {
      setShowForm(false);
      setEditingData(null);
      fetchProjects();
    }
    setFormLoading(false);
  }

  async function handleDelete() {
    if (!deleteId) return;
    const project = projects.find(p => p.id === deleteId);
    await supabase.from("projects").delete().eq("id", deleteId);
    if(user && project) await logAction(user.id, "Project Deleted", "Project", `Deleted project: ${project.name}`);
    setDeleteId(null);
    fetchProjects();
  }

  function getStatusColor(status: string) {
    if (status === "Active") return "bg-green-500/20 text-green-400";
    if (status === "Completed") return "bg-blue-500/20 text-blue-400";
    return "bg-yellow-500/20 text-yellow-400";
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Projects</h2>
          <p className="text-gray-400 text-sm">Manage your client projects</p>
        </div>
        
        {canAdd && (
          <button onClick={() => { setEditingData(null); setShowForm(true); }} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg font-medium transition-colors w-fit">
            <Plus size={18} /> Add Project
          </button>
        )}
      </div>

      <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
        <table className="w-full text-left">
          <thead className="border-b border-gray-700 bg-gray-900/50">
            <tr>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase">Project Name</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase hidden md:table-cell">Client</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase">Status</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase text-right hidden sm:table-cell">Start Date</th>
              <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase text-right">End Date</th>
              {showActions && (
                <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase text-right">Actions</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700">
            {loading && <tr><td colSpan={showActions ? 6 : 5} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>}
            {!loading && projects.length === 0 && <tr><td colSpan={showActions ? 6 : 5} className="px-4 py-12 text-center text-gray-400">No projects yet.</td></tr>}
            
            {projects.map(p => (
              <tr key={p.id} className="hover:bg-gray-700/50 transition-colors">
                <td className="px-4 py-3">
                  <div className="font-medium text-white">{p.name}</div>
                  {p.description && (
                    <div className="text-xs text-gray-500 truncate max-w-[200px] cursor-help mt-0.5" title={p.description}>
                      {p.description}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-400 hidden md:table-cell">{p.client_name}</td>
                <td className="px-4 py-3"><span className={`text-xs px-2 py-1 rounded ${getStatusColor(p.status)}`}>{p.status}</span></td>
                <td className="px-4 py-3 text-gray-400 text-right hidden sm:table-cell">{new Date(p.start_date).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-gray-400 text-right">{p.end_date ? new Date(p.end_date).toLocaleDateString() : "-"}</td>
                
                {showActions && (
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {canEdit && (
                        <button onClick={() => { setEditingData(p); setShowForm(true); }} className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 rounded transition-colors"><Pencil size={16} /></button>
                      )}
                      {canDelete && (
                        <button onClick={() => setDeleteId(p.id)} className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"><Trash2 size={16} /></button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showForm && (
        <ProjectForm initialData={editingData} onSubmit={handleSubmit} onClose={() => { setShowForm(false); setEditingData(null); }} loading={formLoading} />
      )}

      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 w-full max-w-sm text-center">
            <h3 className="text-lg font-bold text-white mb-2">Delete Project?</h3>
            <p className="text-gray-400 text-sm mb-6 text-red-300">Warning: This will also permanently delete all related incomes and expenses.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteId(null)} className="flex-1 px-4 py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors">Cancel</button>
              <button onClick={handleDelete} className="flex-1 px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}