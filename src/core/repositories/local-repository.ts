import type { IRepository } from './base-repository'

const KEY_PREFIX = 'lyra:'

export class LocalRepository<T extends { id: string }> implements IRepository<T> {
  protected readonly storageKey: string

  constructor(storageKey: string) {
    this.storageKey = storageKey
  }

  private get key(): string {
    return `${KEY_PREFIX}${this.storageKey}`
  }

  protected readAll(): T[] {
    const raw = localStorage.getItem(this.key)
    return raw ? (JSON.parse(raw) as T[]) : []
  }

  protected writeAll(items: T[]): void {
    localStorage.setItem(this.key, JSON.stringify(items))
  }

  async getAll(): Promise<T[]> {
    return this.readAll()
  }

  async getById(id: string): Promise<T | undefined> {
    return this.readAll().find((item) => item.id === id)
  }

  async create(item: T): Promise<T> {
    const items = this.readAll()
    items.push(item)
    this.writeAll(items)
    return item
  }

  async update(id: string, updates: Partial<T>): Promise<T> {
    const items = this.readAll()
    const index = items.findIndex((item) => item.id === id)
    if (index === -1) throw new Error(`Item not found: ${id}`)
    items[index] = { ...items[index], ...updates }
    this.writeAll(items)
    return items[index]
  }

  async delete(id: string): Promise<void> {
    const items = this.readAll().filter((item) => item.id !== id)
    this.writeAll(items)
  }

  async query(predicate: (item: T) => boolean): Promise<T[]> {
    return this.readAll().filter(predicate)
  }
}
