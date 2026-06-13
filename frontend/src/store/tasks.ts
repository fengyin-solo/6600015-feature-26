import { create } from 'zustand'
import type { Task, ClusterNode, MetricsSnapshot, TaskStatus, TaskPriority } from '../types'

const STORAGE_KEY = 'scheduler.tasks.v1'

function mockNodes(): ClusterNode[] {
  return Array.from({ length: 5 }, (_, i) => ({
    id: `node-${i + 1}`,
    name: i === 0 ? 'scheduler-main' : `worker-${i}`,
    type: i === 0 ? 'scheduler' as const : 'worker' as const,
    status: Math.random() > 0.1 ? 'online' as const : 'overloaded' as const,
    cpu: 20 + Math.random() * 60,
    memory: 30 + Math.random() * 50,
    tasks: Math.floor(Math.random() * 8),
    uptime: 3600 + Math.floor(Math.random() * 86400),
  }))
}

function mockTasks(nodes: ClusterNode[]): Task[] {
  const names = ['data_sync', 'email_batch', 'report_gen', 'cache_warm', 'log_rotate', 'db_backup', 'index_rebuild', 'health_check']
  const priorities: TaskPriority[] = ['low', 'medium', 'high', 'urgent']
  return Array.from({ length: 12 }, (_, i) => {
    const status: TaskStatus[] = ['pending', 'running', 'success', 'failed']
    const s = status[Math.floor(Math.random() * 4)]
    const node = nodes[Math.floor(Math.random() * nodes.length)]
    const p = priorities[Math.floor(Math.random() * 4)]
    return {
      id: `task-${1000 + i}`,
      name: names[i % names.length],
      priority: p,
      expectedCompletionAt: Date.now() + Math.floor(Math.random() * 86400000),
      status: s,
      node: node.name,
      createdAt: Date.now() - Math.floor(Math.random() * 600000),
      startedAt: s !== 'pending' ? Date.now() - Math.floor(Math.random() * 300000) : undefined,
      completedAt: (s === 'success' || s === 'failed') ? Date.now() - Math.floor(Math.random() * 60000) : undefined,
      retries: s === 'failed' ? Math.floor(Math.random() * 3) : 0,
      maxRetries: 3,
      duration: s === 'success' ? 1000 + Math.floor(Math.random() * 30000) : undefined,
      logs: [`[INFO] Task ${names[i % names.length]} started`, `[INFO] Processing on ${node.name}`],
    }
  })
}

function loadTasksFromStorage(nodes: ClusterNode[]): Task[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    }
  } catch (_e) { /* ignore */ }
  return mockTasks(nodes)
}

function saveTasksToStorage(tasks: Task[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks))
  } catch (_e) { /* ignore */ }
}

const initialNodes = mockNodes()

interface TaskStore {
  tasks: Task[]
  nodes: ClusterNode[]
  metrics: MetricsSnapshot[]
  selectedTask: Task | null
  addTask: (name: string, priority: TaskPriority, expectedCompletionAt: number) => Promise<Task | null>
  retryTask: (id: string) => Promise<void>
  cancelTask: (id: string) => Promise<void>
  selectTask: (t: Task | null) => void
  refreshNodes: () => void
  addMetric: () => void
  loadInitialTasks: () => void
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: loadTasksFromStorage(initialNodes),
  nodes: initialNodes,
  metrics: Array.from({ length: 20 }, (_, i) => ({
    time: Date.now() - (20 - i) * 5000,
    totalTasks: 100 + i * 2,
    runningTasks: 3 + Math.floor(Math.random() * 5),
    successRate: 85 + Math.random() * 14,
    avgLatency: 500 + Math.random() * 2000,
    nodeCount: 5,
  })),
  selectedTask: null,

  loadInitialTasks: () => {
    set({ tasks: loadTasksFromStorage(get().nodes) })
  },

  addTask: async (name, priority, expectedCompletionAt) => {
    if (!name || !priority || !expectedCompletionAt) return null

    try {
      const resp = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, priority, expectedCompletionAt })
      })
      if (resp.ok) {
        const data = await resp.json()
        const task: Task = {
          id: data.task.id,
          name: data.task.name,
          priority: data.task.priority as TaskPriority,
          expectedCompletionAt: data.task.expected_completion_at ?? undefined,
          status: data.task.status as TaskStatus,
          node: data.task.node,
          createdAt: data.task.createdAt ?? data.task.created_at ?? Date.now(),
          retries: data.task.retries ?? 0,
          maxRetries: data.task.max_retries ?? 3,
          logs: data.task.logs ?? [`[INFO] Task ${name} queued`],
        }
        const newTasks = [task, ...get().tasks]
        set({ tasks: newTasks })
        saveTasksToStorage(newTasks)
        return task
      }
    } catch (_e) { /* fallback to local */ }

    const task: Task = {
      id: `task-${Date.now()}`,
      name,
      priority,
      expectedCompletionAt,
      status: 'pending',
      node: get().nodes[Math.floor(Math.random() * get().nodes.length)].name,
      createdAt: Date.now(),
      retries: 0,
      maxRetries: 3,
      logs: [`[INFO] Task ${name} queued`],
    }
    const newTasks = [task, ...get().tasks]
    set({ tasks: newTasks })
    saveTasksToStorage(newTasks)
    return task
  },

  retryTask: async (id) => {
    try {
      await fetch(`/api/tasks/${id}/retry`, { method: 'POST' })
    } catch (_e) { /* ignore */ }
    const newTasks = get().tasks.map(t =>
      t.id === id ? { ...t, status: 'pending' as TaskStatus, retries: t.retries + 1, logs: [...t.logs, '[INFO] Retrying...'] } : t
    )
    set({ tasks: newTasks })
    saveTasksToStorage(newTasks)
  },

  cancelTask: async (id) => {
    try {
      await fetch(`/api/tasks/${id}/cancel`, { method: 'POST' })
    } catch (_e) { /* ignore */ }
    const newTasks = get().tasks.map(t =>
      t.id === id ? { ...t, status: 'failed' as TaskStatus, logs: [...t.logs, '[WARN] Cancelled by user'] } : t
    )
    set({ tasks: newTasks })
    saveTasksToStorage(newTasks)
  },

  selectTask: (t) => set({ selectedTask: t }),

  refreshNodes: () => set({ nodes: mockNodes() }),

  addMetric: () => {
    const m: MetricsSnapshot = {
      time: Date.now(),
      totalTasks: get().tasks.length,
      runningTasks: get().tasks.filter(t => t.status === 'running').length,
      successRate: (get().tasks.filter(t => t.status === 'success').length / Math.max(get().tasks.length, 1)) * 100,
      avgLatency: 500 + Math.random() * 2000,
      nodeCount: get().nodes.filter(n => n.status !== 'offline').length,
    }
    set({ metrics: [...get().metrics.slice(-30), m] })
  },
}))
