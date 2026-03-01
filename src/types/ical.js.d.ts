declare module 'ical.js' {
  export function parse(input: string): unknown
  export class Component {
    constructor(jCal: unknown)
    getAllSubcomponents(name: string): unknown[]
  }
  export class Event {
    constructor(component: unknown)
    uid: string
    summary: string
    description: string
    location: string
    startDate: {
      toJSDate(): Date
      isDate: boolean
    } | null
    endDate: {
      toJSDate(): Date
      isDate: boolean
    } | null
  }
}
