const requireDashboardOwner = (req, res, next) => {
  if (!req.dashboardUser || req.dashboardUser.role !== 'owner') {
    return res.status(403).json({ error: 'Owner access required' });
  }

  return next();
};

module.exports = requireDashboardOwner;