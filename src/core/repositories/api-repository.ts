import type { IRepository } from './base-repository'
import { API_URL } from '@/lib/api-url'

export class ApiRepository<T extends { id: string }> implements IRepository<T> {
  protected readonly baseUrl: string
  protected readonly resource: string

  constructor(resource: string) {
    this.baseUrl = API_URL
    this.resource = resource
  }

  protected getHeaders(): HeadersInit {
    const token = localStorage.getItem('life-os:token')
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }
  }

  private handleUnauthorized(res: Response): void {
    if (res.status === 401) {
      localStorage.removeItem('life-os:token')
      localStorage.removeItem('life-os:auth')
      window.location.href = '/login'
    }
  }

  async getAll(): Promise<T[]> {
    const res = await fetch(`${this.baseUrl}/${this.resource}`, {
      headers: this.getHeaders(),
    })
    if (!res.ok) {
      this.handleUnauthorized(res)
      throw new Error(`Failed to fetch ${this.resource}`)
    }
    return res.json()
  }

  async getById(id: string): Promise<T | undefined> {
    const res = await fetch(`${this.baseUrl}/${this.resource}/${id}`, {
      headers: this.getHeaders(),
    })
    if (res.status === 404) return undefined
    if (!res.ok) {
      this.handleUnauthorized(res)
      throw new Error(`Failed to fetch ${this.resource}/${id}`)
    }
    return res.json()
  }

  async create(item: T): Promise<T> {
    const res = await fetch(`${this.baseUrl}/${this.resource}`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(item),
    })
    if (!res.ok) {
      this.handleUnauthorized(res)
      throw new Error(`Failed to create ${this.resource}`)
    }
    return res.json()
  }

  async update(id: string, updates: Partial<T>): Promise<T> {
    const res = await fetch(`${this.baseUrl}/${this.resource}/${id}`, {
      method: 'PATCH',
      headers: this.getHeaders(),
      body: JSON.stringify(updates),
    })
    if (!res.ok) {
      this.handleUnauthorized(res)
      throw new Error(`Failed to update ${this.resource}/${id}`)
    }
    return res.json()
  }

  async delete(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/${this.resource}/${id}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    })
    if (!res.ok) {
      this.handleUnauthorized(res)
      throw new Error(`Failed to delete ${this.resource}/${id}`)
    }
  }

  async query(predicate: (item: T) => boolean): Promise<T[]> {
    // API can't execute JS predicates, so fetch all and filter client-side
    const all = await this.getAll()
    return all.filter(predicate)
  }
}
