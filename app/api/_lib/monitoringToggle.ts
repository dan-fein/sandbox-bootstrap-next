const FLAG_NAME = 'NEXT_APP_SKIP_MONITORING_ROUTES';

export function monitoringRoutesDisabled(): boolean {
  const value = process.env[FLAG_NAME];

  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();

  return normalized !== '' && normalized !== 'false' && normalized !== '0' && normalized !== 'off';
}

export function monitoringRoutesFlagValue(): string | undefined {
  return process.env[FLAG_NAME];
}

