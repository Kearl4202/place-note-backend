const { supabase } = require('./database');
const axios = require('axios');

// Push notification helper (same as used in route files)
const sendPushNotification = async (pushToken, title, body, data = {}) => {
  try {
    await axios.post('https://exp.host/--/api/v2/push/send', {
      to: pushToken,
      title,
      body,
      sound: 'default',
      data,
    });
  } catch (error) {
    console.error('🔔 Error sending push notification:', error.message);
  }
};

// Subscription tier limits (must match subscriptions.js)
const TIER_LIMITS = {
  'The Viewer': { notes: 5, contacts: 5, groups: 0, projects: 0 },
  'The Notifier': { notes: 10, contacts: 20, groups: 2, projects: 0 },
  'The Inspector': { notes: 20, contacts: 50, groups: 5, projects: 2 },
  'The Chief': { notes: 50, contacts: 500, groups: 10, projects: 10 },
};

// ============================================================
// DOWNGRADE HANDLER
// Called when a user's subscription changes to a lower tier
// ============================================================
async function handleDowngrade(userId, newTier) {
  try {
    const limits = TIER_LIMITS[newTier] || TIER_LIMITS['The Viewer'];
    const results = { archived: [], deactivated: [] };

    // 1. Archive excess Place Notes (newest first)
    const { data: activeNotes } = await supabase
      .from('place_notes')
      .select('id, name, created_at')
      .eq('creator_id', userId)
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    if (activeNotes && activeNotes.length > limits.notes) {
      const toArchive = activeNotes.slice(limits.notes);
      for (const note of toArchive) {
        await supabase
          .from('place_notes')
          .update({ status: 'archived' })
          .eq('id', note.id);
        results.archived.push(`Place Note: ${note.name}`);
      }
    }

    // 2. Archive excess Projects (newest first, excluding Personal)
    const { data: projects } = await supabase
      .from('projects')
      .select('id, name, created_at')
      .eq('owner_id', userId)
      .neq('name', 'Personal')
      .order('created_at', { ascending: false });

    if (projects && projects.length > limits.projects) {
      const toArchive = projects.slice(limits.projects);

      // Get user's Personal project
      const { data: personalProject } = await supabase
        .from('projects')
        .select('id')
        .eq('owner_id', userId)
        .eq('name', 'Personal')
        .single();

      for (const proj of toArchive) {
        // Move notes from archived project to Personal
        if (personalProject) {
          await supabase
            .from('place_notes')
            .update({ project_id: personalProject.id })
            .eq('project_id', proj.id)
            .eq('creator_id', userId);
        }

        // Archive the project
        await supabase
          .from('projects')
          .update({ status: 'archived' })
          .eq('id', proj.id);
        results.archived.push(`Project: ${proj.name}`);
      }
    }

    // 3. Archive excess Groups (newest first)
    const { data: groups } = await supabase
      .from('groups')
      .select('id, name, created_at')
      .eq('created_by', userId)
      .order('created_at', { ascending: false });

    if (groups && groups.length > limits.groups) {
      const toArchive = groups.slice(limits.groups);
      for (const group of toArchive) {
        await supabase
          .from('groups')
          .update({ status: 'archived' })
          .eq('id', group.id);
        results.archived.push(`Group: ${group.name}`);
      }
    }

    // 4. Deactivate excess Contacts (newest first)
    const { data: contacts } = await supabase
      .from('contacts')
      .select('id, contact_user_id, created_at')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    if (contacts && contacts.length > limits.contacts) {
      const toDeactivate = contacts.slice(limits.contacts);
      for (const contact of toDeactivate) {
        await supabase
          .from('contacts')
          .update({ status: 'inactive' })
          .eq('id', contact.id);

        // Get contact name for notification
        const { data: contactUser } = await supabase
          .from('users')
          .select('name')
          .eq('id', contact.contact_user_id)
          .single();

        results.deactivated.push(contactUser?.name || 'Unknown contact');
      }
    }

    // Send notification to user about changes
    if (results.archived.length > 0 || results.deactivated.length > 0) {
      const { data: user } = await supabase
        .from('users')
        .select('push_token')
        .eq('id', userId)
        .single();

      if (user?.push_token) {
        let message = 'Your subscription has changed. ';
        if (results.archived.length > 0) {
          message += `${results.archived.length} item(s) were archived. `;
        }
        if (results.deactivated.length > 0) {
          message += `${results.deactivated.length} contact(s) were deactivated. `;
        }
        message += 'Open the app to review.';

        await sendPushNotification(
          user.push_token,
          '📋 Subscription Updated',
          message,
          { screen: 'home' }
        );
      }
    }

    console.log(`📋 Downgrade handled for user ${userId} to ${newTier}:`, results);
    return results;

  } catch (error) {
    console.error('Error handling downgrade:', error);
    throw error;
  }
}

// ============================================================
// ARCHIVE CLEANUP - Run daily via cron
// Deletes archived notes older than 30 days
// Sends warning notification 5 days before deletion
// ============================================================
async function archiveCleanup() {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const twentyFiveDaysAgo = new Date(now - 25 * 24 * 60 * 60 * 1000);
    const twentySixDaysAgo = new Date(now - 26 * 24 * 60 * 60 * 1000);

    console.log('🗑️ Running archive cleanup...');

    // 1. Send 5-day warning for notes archived 25-26 days ago
    const { data: warningNotes } = await supabase
      .from('place_notes')
      .select('id, name, creator_id')
      .eq('status', 'archived')
      .gte('updated_at', twentySixDaysAgo.toISOString())
      .lt('updated_at', twentyFiveDaysAgo.toISOString());

    if (warningNotes && warningNotes.length > 0) {
      // Group by creator
      const byCreator = {};
      for (const note of warningNotes) {
        if (!byCreator[note.creator_id]) byCreator[note.creator_id] = [];
        byCreator[note.creator_id].push(note.name);
      }

      for (const [creatorId, noteNames] of Object.entries(byCreator)) {
        const { data: user } = await supabase
          .from('users')
          .select('push_token')
          .eq('id', creatorId)
          .single();

        if (user?.push_token) {
          const nameList = noteNames.length === 1
            ? `"${noteNames[0]}"`
            : `${noteNames.length} archived notes`;

          await sendPushNotification(
            user.push_token,
            '⚠️ Archived Notes Expiring Soon',
            `${nameList} will be permanently deleted in 5 days. Restore them from the archive if needed.`,
            { screen: 'archive' }
          );
          console.log(`⚠️ Sent archive warning to user ${creatorId} for ${noteNames.length} note(s)`);
        }
      }
    }

    // 2. Delete notes archived more than 30 days ago
    const { data: expiredNotes } = await supabase
      .from('place_notes')
      .select('id, name, creator_id')
      .eq('status', 'archived')
      .lt('updated_at', thirtyDaysAgo.toISOString());

    if (expiredNotes && expiredNotes.length > 0) {
      for (const note of expiredNotes) {
        // Delete related data first
        await supabase.from('tags').delete().eq('place_note_id', note.id);
        await supabase.from('assignments').delete().eq('place_note_id', note.id);
        await supabase.from('place_note_messages').delete().eq('place_note_id', note.id);
        await supabase.from('geofence_notifications').delete().eq('place_note_id', note.id);

        // Delete the note itself
        await supabase.from('place_notes').delete().eq('id', note.id);

        console.log(`🗑️ Permanently deleted: ${note.name} (${note.id})`);
      }

      // Notify creators
      const byCreator = {};
      for (const note of expiredNotes) {
        if (!byCreator[note.creator_id]) byCreator[note.creator_id] = [];
        byCreator[note.creator_id].push(note.name);
      }

      for (const [creatorId, noteNames] of Object.entries(byCreator)) {
        const { data: user } = await supabase
          .from('users')
          .select('push_token')
          .eq('id', creatorId)
          .single();

        if (user?.push_token) {
          await sendPushNotification(
            user.push_token,
            '🗑️ Archived Notes Deleted',
            `${noteNames.length} archived note(s) have been permanently deleted after 30 days.`,
            { screen: 'home' }
          );
        }
      }

      console.log(`🗑️ Deleted ${expiredNotes.length} expired archived notes`);
    } else {
      console.log('🗑️ No expired archived notes to delete');
    }

  } catch (error) {
    console.error('Error in archive cleanup:', error);
  }
}

module.exports = { handleDowngrade, archiveCleanup };
