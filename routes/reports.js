const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { getUserSubscriptionInfo } = require('../config/subscriptions');
const PDFDocument = require('pdfkit');
const axios = require('axios');

// Generate PDF report for a place note
router.get('/:noteId', authenticateToken, async function(req, res) {
  try {
    console.log('Report requested for note:', req.params.noteId, 'by user:', req.user.userId);
    var userId = req.user.userId;
    var noteId = req.params.noteId;

    // Check subscription - only Inspector and Chief tiers
    var subInfo = await getUserSubscriptionInfo(userId);
    if (subInfo.tier.level < 2) {
      return res.status(403).json({ error: 'PDF reports are available for Inspector and Chief subscribers only. Please upgrade your plan.' });
    }

    // Fetch the place note
    var { data: note, error: noteError } = await supabase
      .from('place_notes')
      .select('*, users!place_notes_creator_id_fkey (name, email), projects (name)')
      .eq('id', noteId)
      .single();

    if (noteError || !note) {
      return res.status(404).json({ error: 'Place note not found' });
    }

    // Verify user is creator or assigned
    var isCreator = note.creator_id === userId;
    if (!isCreator) {
      // Check if user is assigned
      var { data: myContacts } = await supabase
        .from('contacts')
        .select('id')
        .eq('contact_user_id', userId)
        .eq('status', 'active');
      var myContactIds = (myContacts || []).map(function(c) { return c.id; });

      var { data: assignments } = await supabase
        .from('assignments')
        .select('user_id, group_id')
        .eq('place_note_id', noteId);

      var isAssigned = false;
      for (var a of (assignments || [])) {
        if (myContactIds.includes(a.user_id)) { isAssigned = true; break; }
      }
      if (!isAssigned) {
        return res.status(403).json({ error: 'You do not have access to this note' });
      }
    }

    // Fetch chat/tags timeline
    var { data: chatMessages } = await supabase
      .from('chat')
      .select('*, users!chat_user_id_fkey (name)')
      .eq('place_note_id', noteId)
      .order('created_at', { ascending: true });

    // Fetch assignments with user names
    var { data: assignmentData } = await supabase
      .from('assignments')
      .select('*, contacts (name)')
      .eq('place_note_id', noteId);

    // Build PDF
    var doc = new PDFDocument({ size: 'letter', margins: { top: 50, bottom: 50, left: 50, right: 50 } });

    // Set response headers
    var fileName = (note.name || 'report').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="PlaceNote_' + fileName + '_Report.pdf"');
    doc.pipe(res);

    var pageWidth = 512; // letter width minus margins

    // ============ HEADER ============
    doc.rect(0, 0, 612, 100).fill('#4F46E5');
    doc.fillColor('white').fontSize(28).font('Helvetica-Bold').text('Place Note', 50, 30, { width: pageWidth });
    doc.fontSize(12).font('Helvetica').text('Location-Based Task Report', 50, 65, { width: pageWidth });

    doc.moveDown(3);
    doc.fillColor('#111827');

    // ============ NOTE INFO ============
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#4F46E5').text(note.name || 'Untitled Note');
    doc.moveDown(0.3);

    if (note.description) {
      doc.fontSize(12).font('Helvetica').fillColor('#374151').text(note.description);
      doc.moveDown(0.5);
    }

    // Info box
    var infoY = doc.y;
    doc.rect(50, infoY, pageWidth, 1).fill('#E5E7EB');
    doc.moveDown(0.5);

    doc.fontSize(10).font('Helvetica').fillColor('#6B7280');

    var infoLines = [];
    infoLines.push('Status: ' + (note.status || 'unknown').toUpperCase());
    infoLines.push('Created: ' + new Date(note.created_at + 'Z').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
    if (note.archived_at) {
      infoLines.push('Archived: ' + new Date(note.archived_at + 'Z').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
    }
    infoLines.push('Creator: ' + (note.users?.name || 'Unknown') + ' (' + (note.users?.email || '') + ')');
    if (note.projects?.name) {
      infoLines.push('Project: ' + note.projects.name);
    }
    infoLines.push('Location: ' + (note.latitude ? parseFloat(note.latitude).toFixed(6) + ', ' + parseFloat(note.longitude).toFixed(6) : 'Not set'));
    if (note.perimeter) {
      infoLines.push('Perimeter: ' + note.perimeter + ' meters');
    }

    for (var line of infoLines) {
      doc.text(line);
      doc.moveDown(0.2);
    }

    doc.moveDown(0.5);
    doc.rect(50, doc.y, pageWidth, 1).fill('#E5E7EB');
    doc.moveDown(0.5);

    // ============ ASSIGNED USERS ============
    if (assignmentData && assignmentData.length > 0) {
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#4F46E5').text('Assigned Users');
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica').fillColor('#374151');
      for (var assignment of assignmentData) {
        var assignName = assignment.contacts?.name || 'Unknown';
        doc.text('• ' + assignName);
        doc.moveDown(0.15);
      }
      doc.moveDown(0.5);
      doc.rect(50, doc.y, pageWidth, 1).fill('#E5E7EB');
      doc.moveDown(0.5);
    }

    // ============ TIMELINE ============
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#4F46E5').text('Activity Timeline');
    doc.moveDown(0.5);

    if (!chatMessages || chatMessages.length === 0) {
      doc.fontSize(10).font('Helvetica').fillColor('#9CA3AF').text('No activity recorded for this note.');
    } else {
      for (var i = 0; i < chatMessages.length; i++) {
        var msg = chatMessages[i];
        var senderName = msg.users?.name || 'Unknown';
        var timestamp = new Date(msg.created_at + 'Z').toLocaleDateString('en-US', {
          year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        var msgType = msg.type || 'text';

        // Check if we need a new page
        if (doc.y > 680) {
          doc.addPage();
        }

        // Timeline dot and line
        var dotX = 60;
        var dotY = doc.y + 5;
        doc.circle(dotX, dotY, 4).fill(msgType === 'photo' ? '#10B981' : msgType === 'document' ? '#F59E0B' : '#4F46E5');
        if (i < chatMessages.length - 1) {
          doc.moveTo(dotX, dotY + 4).lineTo(dotX, dotY + 40).stroke('#E5E7EB');
        }

        // Content
        var contentX = 75;
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#111827').text(senderName, contentX, dotY - 3, { width: pageWidth - 35 });
        doc.fontSize(8).font('Helvetica').fillColor('#9CA3AF').text(timestamp, contentX + 200, dotY - 3, { width: 200, align: 'right' });

        doc.moveDown(0.2);

        if (msgType === 'text') {
          doc.fontSize(10).font('Helvetica').fillColor('#374151').text(msg.message || '', contentX, doc.y, { width: pageWidth - 35 });
        } else if (msgType === 'photo') {
          doc.fontSize(10).font('Helvetica').fillColor('#10B981').text('📷 Photo attached', contentX, doc.y, { width: pageWidth - 35 });
          if (msg.file_url) {
            doc.fontSize(8).fillColor('#6B7280').text(msg.file_url, contentX, doc.y, { width: pageWidth - 35 });
          }
        } else if (msgType === 'document') {
          var docName = msg.file_name || msg.message || 'Document';
          doc.fontSize(10).font('Helvetica').fillColor('#F59E0B').text('📄 ' + docName, contentX, doc.y, { width: pageWidth - 35 });
          if (msg.file_url) {
            doc.fontSize(8).fillColor('#6B7280').text(msg.file_url, contentX, doc.y, { width: pageWidth - 35 });
          }
        }

        doc.moveDown(1);
      }
    }

    // ============ FOOTER ============
    doc.moveDown(2);
    if (doc.y > 700) doc.addPage();
    doc.rect(50, doc.y, pageWidth, 1).fill('#E5E7EB');
    doc.moveDown(0.5);
    doc.fontSize(8).font('Helvetica').fillColor('#9CA3AF').text(
      'Generated by Place Note on ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      { align: 'center', width: pageWidth }
    );
    doc.text('This report is for documentation purposes only.', { align: 'center', width: pageWidth });

    doc.end();

  } catch (error) {
    console.error('Error generating PDF report:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate report' });
    }
  }
});

module.exports = router;
