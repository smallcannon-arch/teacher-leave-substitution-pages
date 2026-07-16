function calculationInput(caseData = {}) {
  return {
    teacherId: caseData.teacherId || "",
    leaveType: caseData.leaveType || "",
    officialReason: caseData.officialReason || "",
    startDate: caseData.startDate || "",
    endDate: caseData.endDate || "",
    startTime: caseData.startTime || "",
    endTime: caseData.endTime || "",
    startPart: caseData.startPart || "",
    endPart: caseData.endPart || "",
    leaveHours: Number(caseData.leaveHours || 0),
    accumulatedHoursBefore: Number(caseData.accumulatedHoursBefore || 0),
    consecutiveSickDays: Number(caseData.consecutiveSickDays || 0),
    businessTripDays: Number(caseData.businessTripDays || 0),
    hasHomeroomDuty: Boolean(caseData.hasHomeroomDuty),
    homeroomProxyId: caseData.homeroomProxyId || "",
    homeroomStartDate: caseData.homeroomStartDate || "",
    homeroomEndDate: caseData.homeroomEndDate || "",
    homeroomStartPart: caseData.homeroomStartPart || "",
    homeroomEndPart: caseData.homeroomEndPart || "",
    affectedPeriods: (caseData.affectedPeriods || []).map((period) => ({
      id: period.id || "",
      date: period.date || "",
      periodNo: Number(period.periodNo || 0),
      className: period.className || "",
      subject: period.subject || "",
      handling: period.handling || "",
      substituteId: period.substituteId || "",
      fundSourceId: period.fundSourceId || "",
      thresholdZone: period.thresholdZone || "",
      isOvertime: Boolean(period.isOvertime),
    })),
    manualFees: (caseData.manualFees || []).map((fee) => ({
      id: fee.id || "",
      type: fee.type || "",
      payeeId: fee.payeeId || "",
      quantity: Number(fee.quantity || 0),
      unitRate: Number(fee.unitRate || 0),
      amount: Number(fee.amount || 0),
      serviceMonth: fee.serviceMonth || "",
      ruleId: fee.ruleId || "",
      reasonCode: fee.reasonCode || "",
      documentRef: fee.documentRef || "",
    })),
  };
}

export function calculationInputSignature(caseData) {
  return JSON.stringify(calculationInput(caseData));
}

export function invalidateCaseCalculation(caseData) {
  if (!caseData || caseData.status === "closed") return false;
  const changed = Boolean(caseData.calculation)
    || Boolean(caseData.allocations?.length)
    || !["", "draft"].includes(caseData.status || "");
  caseData.calculation = null;
  caseData.allocations = [];
  caseData.status = "draft";
  return changed;
}

export function invalidateIfCalculationInputChanged(caseData, previousSignature) {
  const expectedSignature = caseData?.calculation?.inputSignature || previousSignature;
  if (calculationInputSignature(caseData) === expectedSignature) return false;
  return invalidateCaseCalculation(caseData);
}
