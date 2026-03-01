export interface IRepository<T extends { id: string }> {
  getAll(): Promise<T[]>
  getById(id: string): Promise<T | undefined>
  create(item: T): Promise<T>
  update(id: string, updates: Partial<T>): Promise<T>
  delete(id: string): Promise<void>
  query(predicate: (item: T) => boolean): Promise<T[]>
}
