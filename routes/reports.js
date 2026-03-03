const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { getUserSubscriptionInfo } = require('../config/subscriptions');
const PDFDocument = require('pdfkit');
const axios = require('axios');
const path = require('path');

// Helper: get file name from URL
function getFileNameFromUrl(url) {
  if (!url) return 'Unknown file';
  try {
    var parts = url.split('/');
    var fullName = decodeURIComponent(parts[parts.length - 1]);
    // Remove timestamp prefix if present (e.g., 1234567890_filename.pdf)
    if (/^\d+_/.test(fullName)) {
      fullName = fullName.replace(/^\d+_/, '');
    }
    return fullName;
  } catch (e) {
    return 'Unknown file';
  }
}

// Helper: get file extension label
function getFileTypeLabel(url) {
  if (!url) return 'File';
  var ext = path.extname(url).toLowerCase().replace('.', '').toUpperCase();
  if (['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP', 'HEIC'].includes(ext)) return 'Photo (' + ext + ')';
  if (['PDF'].includes(ext)) return 'PDF Document';
  if (['DOC', 'DOCX'].includes(ext)) return 'Word Document';
  if (['XLS', 'XLSX'].includes(ext)) return 'Spreadsheet';
  if (['TXT'].includes(ext)) return 'Text File';
  if (['MP4', 'MOV', 'AVI'].includes(ext)) return 'Video (' + ext + ')';
  if (ext) return ext + ' File';
  return 'File';
}

// Generate PDF report for a place note
router.get('/:noteId', authenticateToken, async function(req, res) {
  try {
    var userId = req.user.userId;
    var noteId = req.params.noteId;

    console.log('Report requested for note:', noteId, 'by user:', userId);

    // Check subscription - only Inspector and Chief tiers
    var subInfo = await getUserSubscriptionInfo(userId);
    if (subInfo.tier.level < 2) {
      return res.status(403).json({ error: 'PDF reports are available for Inspector and Chief subscribers only. Please upgrade your plan.' });
    }

    // Fetch the place note
    var { data: note, error: noteError } = await supabase
      .from('place_notes')
      .select('*, users!place_notes_creator_id_fkey(name, email), projects(name)')
      .eq('id', noteId)
      .single();

    if (noteError || !note) {
      console.log('Note fetch error:', noteError?.message);
      return res.status(404).json({ error: 'Place note not found' });
    }

    // Verify user is creator or assigned
    var isCreator = note.creator_id === userId;
    if (!isCreator) {
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
    var { data: chatMessages, error: chatError } = await supabase
      .from('chat')
      .select('*, users!chat_user_id_fkey(name)')
      .eq('place_note_id', noteId)
      .order('created_at', { ascending: true });

    console.log('Chat messages found:', chatMessages?.length || 0, 'Error:', chatError?.message || 'none');

    // Fetch assignments with user names
    var { data: assignmentData } = await supabase
      .from('assignments')
      .select('*, contacts(name)')
      .eq('place_note_id', noteId);

    // Try to fetch the logo from Supabase storage
    var logoBuffer = null;
    try {
      var { data: logoUrl } = supabase.storage.from('place-note-files').getPublicUrl('logo.png');
      if (logoUrl && logoUrl.publicUrl) {
        var logoResponse = await axios.get(logoUrl.publicUrl, { responseType: 'arraybuffer', timeout: 5000 });
        logoBuffer = Buffer.from(logoResponse.data);
      }
    } catch (e) {
      console.log('Could not fetch logo, using text header instead');
    }

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

    if (logoBuffer) {
      try {
        doc.image(logoBuffer, 50, 15, { width: 70, height: 70 });
        doc.fillColor('white').fontSize(26).font('Helvetica-Bold').text('Place Note', 130, 25, { width: pageWidth - 80 });
        doc.fontSize(11).font('Helvetica').text('Location-Based Task Report', 130, 58, { width: pageWidth - 80 });
      } catch (e) {
        // Fallback if logo fails to render
        doc.fillColor('white').fontSize(28).font('Helvetica-Bold').text('Place Note', 50, 30, { width: pageWidth });
        doc.fontSize(12).font('Helvetica').text('Location-Based Task Report', 50, 65, { width: pageWidth });
      }
    } else {
      doc.fillColor('white').fontSize(28).font('Helvetica-Bold').text('Place Note', 50, 30, { width: pageWidth });
      doc.fontSize(12).font('Helvetica').text('Location-Based Task Report', 50, 65, { width: pageWidth });
    }

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
    if (note.perimeter_feet) {
      infoLines.push('Perimeter: ' + note.perimeter_feet + ' feet');
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
        var msgType = msg.message_type || 'text';

        // Check if we need a new page
        if (doc.y > 660) {
          doc.addPage();
        }

        // Timeline dot and line
        var dotX = 60;
        var dotY = doc.y + 5;
        var dotColor = '#4F46E5'; // default blue for text
        if (msgType === 'photo') dotColor = '#10B981'; // green
        if (msgType === 'document') dotColor = '#F59E0B'; // yellow

        doc.circle(dotX, dotY, 4).fill(dotColor);
        if (i < chatMessages.length - 1) {
          doc.moveTo(dotX, dotY + 4).lineTo(dotX, dotY + 45).stroke('#E5E7EB');
        }

        // Sender and timestamp
        var contentX = 75;
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#111827').text(senderName, contentX, dotY - 3, { width: 200, continued: false });
        doc.fontSize(8).font('Helvetica').fillColor('#9CA3AF').text(timestamp, contentX + 200, dotY - 3, { width: 200, align: 'right' });

        doc.moveDown(0.3);

        if (msgType === 'text') {
          // Text message
          doc.fontSize(10).font('Helvetica').fillColor('#374151').text(msg.content || '', contentX, doc.y, { width: pageWidth - 35 });
        } else if (msgType === 'photo') {
          // Photo attachment
          var photoFileName = getFileNameFromUrl(msg.file_url);
          var photoFileType = getFileTypeLabel(msg.file_url);
          doc.fontSize(10).font('Helvetica').fillColor('#10B981').text('📷 ' + photoFileType, contentX, doc.y, { width: pageWidth - 35 });
          doc.fontSize(9).font('Helvetica').fillColor('#6B7280').text('File: ' + photoFileName, contentX, doc.y, { width: pageWidth - 35 });
          if (msg.content) {
            doc.fontSize(9).font('Helvetica').fillColor('#374151').text('Caption: ' + msg.content, contentX, doc.y, { width: pageWidth - 35 });
          }
        } else if (msgType === 'document') {
          // Document attachment
          var docFileName = getFileNameFromUrl(msg.file_url);
          var docFileType = getFileTypeLabel(msg.file_url);
          doc.fontSize(10).font('Helvetica').fillColor('#F59E0B').text('📄 ' + docFileType, contentX, doc.y, { width: pageWidth - 35 });
          doc.fontSize(9).font('Helvetica').fillColor('#6B7280').text('File: ' + docFileName, contentX, doc.y, { width: pageWidth - 35 });
          if (msg.content) {
            doc.fontSize(9).font('Helvetica').fillColor('#374151').text('Note: ' + msg.content, contentX, doc.y, { width: pageWidth - 35 });
          }
        } else {
          // Any other type
          var otherFileName = getFileNameFromUrl(msg.file_url);
          var otherFileType = getFileTypeLabel(msg.file_url);
          doc.fontSize(10).font('Helvetica').fillColor('#6B7280').text('📎 ' + otherFileType, contentX, doc.y, { width: pageWidth - 35 });
          if (otherFileName !== 'Unknown file') {
            doc.fontSize(9).font('Helvetica').fillColor('#6B7280').text('File: ' + otherFileName, contentX, doc.y, { width: pageWidth - 35 });
          }
          if (msg.content) {
            doc.fontSize(9).font('Helvetica').fillColor('#374151').text(msg.content, contentX, doc.y, { width: pageWidth - 35 });
          }
        }

        doc.moveDown(1.2);
      }
    }

    // ============ ATTACHMENTS SUMMARY ============
    var attachments = (chatMessages || []).filter(function(m) {
      return m.message_type === 'photo' || m.message_type === 'document';
    });

    if (attachments.length > 0) {
      if (doc.y > 600) doc.addPage();
      doc.moveDown(1);
      doc.rect(50, doc.y, pageWidth, 1).fill('#E5E7EB');
      doc.moveDown(0.5);

      doc.fontSize(14).font('Helvetica-Bold').fillColor('#4F46E5').text('Attachments Summary');
      doc.moveDown(0.3);

      doc.fontSize(10).font('Helvetica').fillColor('#374151');
      var photoCount = attachments.filter(function(a) { return a.message_type === 'photo'; }).length;
      var docCount = attachments.filter(function(a) { return a.message_type === 'document'; }).length;

      doc.text('Total attachments: ' + attachments.length + ' (' + photoCount + ' photos, ' + docCount + ' documents)');
      doc.moveDown(0.3);

      for (var j = 0; j < attachments.length; j++) {
        if (doc.y > 700) doc.addPage();
        var att = attachments[j];
        var attName = getFileNameFromUrl(att.file_url);
        var attType = getFileTypeLabel(att.file_url);
        var attDate = new Date(att.created_at + 'Z').toLocaleDateString('en-US', {
          year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        var attSender = att.users?.name || 'Unknown';
        var icon = att.message_type === 'photo' ? '📷' : '📄';

        doc.fontSize(9).font('Helvetica').fillColor('#374151');
        doc.text(icon + ' ' + attName + '  (' + attType + ')', { continued: false });
        doc.fontSize(8).fillColor('#9CA3AF').text('   Added by ' + attSender + ' on ' + attDate);
        doc.moveDown(0.2);
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
