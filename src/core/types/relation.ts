export type RelationType = 'parent' | 'blocks' | 'relates' | 'supports'

export interface Relation {
  id: string
  fromId: string
  toId: string
  type: RelationType
}
