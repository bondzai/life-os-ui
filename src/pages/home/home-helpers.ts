export const DEVICE_TYPES = ['server', 'desktop', 'laptop', 'phone', 'tablet', 'router', 'iot', 'other'] as const
export type DeviceType = (typeof DEVICE_TYPES)[number]

export const SERVICE_TYPES = ['docker', 'web', 'database', 'api', 'monitoring', 'media', 'other'] as const
export type ServiceType = (typeof SERVICE_TYPES)[number]

export const SERVICE_STATUSES = ['running', 'stopped', 'error', 'unknown'] as const
export type ServiceStatus = (typeof SERVICE_STATUSES)[number]

export const SERVICE_STATUS_COLORS: Record<ServiceStatus, string> = {
  running: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  stopped: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
  error: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  unknown: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
}

export const DEVICE_TYPE_COLORS: Record<DeviceType, string> = {
  server: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  desktop: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  laptop: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  phone: 'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200',
  tablet: 'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200',
  router: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  iot: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  other: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
}
