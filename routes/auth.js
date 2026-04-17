// Change email
router.put('/change-email', authenticateToken, async function(req, res) {
  try {
    var newEmail = req.body.new_email;
    var password = req.body.password;

    if (!newEmail || !password) {
      return res.status(400).json({ error: 'New email and password are required' });
    }

    // Validate email format
    var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Get current user and verify password
    var { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', req.user.userId)
      .single();

    if (error || !user) return res.status(404).json({ error: 'User not found' });

    var valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Incorrect password' });

    // Check new email not already taken
    var { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', newEmail)
      .single();

    if (existingUser) {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }

    // Generate verification code for new email
    var verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    var verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Update email and reset verification
    await supabase
      .from('users')
      .update({
        email: newEmail,
        email_verified: false,
        verification_token: verificationCode,
        verification_expires: verificationExpires.toISOString()
      })
      .eq('id', req.user.userId);

    // Send verification email to new address
    await sendEmail(newEmail, 'Verify your new Place Note email',
      'Your email has been changed. Please verify your new email address.\n\nYour verification code is: ' + verificationCode + '\n\nThis code expires in 24 hours.');

    res.json({ message: 'Email changed successfully. Please verify your new email address.' });
  } catch (error) {
    console.error('Change email error:', error);
    res.status(500).json({ error: 'Failed to change email' });
  }
});
