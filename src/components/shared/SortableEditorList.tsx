import React from 'react';
import { useTranslation } from 'react-i18next';
import { GripVertical } from 'lucide-react';
import { DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, sortableKeyboardCoordinates, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface Props<T extends { id: string }> {
  items: T[];
  onReorder: (ids: string[]) => void;
  renderItem: (item: T, index: number, handle: React.ReactNode) => React.ReactNode;
  disabled?: boolean;
}

function SortableRow({ id, disabled, children }: {
  id: string; disabled: boolean; children: (handle: React.ReactNode) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  const handle = (
    <button type="button" ref={setActivatorNodeRef} className="btn btn-icon btn-sm editor-drag-handle"
      {...attributes} {...listeners} disabled={disabled} aria-label={t('editor.dragHandle')} title={t('editor.dragHandle')}
      onClick={event => { event.preventDefault(); event.stopPropagation(); }}
      onPointerDown={event => { event.stopPropagation(); listeners?.onPointerDown?.(event); }}
      onKeyDown={event => { listeners?.onKeyDown?.(event); }}>
      <GripVertical size={14} />
    </button>
  );
  return <div ref={setNodeRef} className={`editor-sortable-row${isDragging ? ' is-dragging' : ''}`}
    style={{ transform: CSS.Transform.toString(transform), transition, position: 'relative', zIndex: isDragging ? 1 : undefined }}>
    {children(handle)}
  </div>;
}

export default function SortableEditorList<T extends { id: string }>({ items, onReorder, renderItem, disabled = false }: Props<T>) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return <DndContext sensors={sensors} collisionDetection={closestCenter} autoScroll onDragEnd={({ active, over }) => {
    if (disabled || !over || active.id === over.id) return;
    const ids = items.map(item => item.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from >= 0 && to >= 0) onReorder(arrayMove(ids, from, to));
  }}>
    <SortableContext items={items.map(item => item.id)} strategy={verticalListSortingStrategy}>
      {items.map((item, index) => <SortableRow key={item.id} id={item.id} disabled={disabled}>
        {handle => renderItem(item, index, handle)}
      </SortableRow>)}
    </SortableContext>
  </DndContext>;
}
