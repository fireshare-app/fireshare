"""add discord_id to user

Revision ID: v7q8r9s0t1u2
Revises: u6p7q8r9s0t1
Create Date: 2026-10-01 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'v7q8r9s0t1u2'
down_revision = 'u6p7q8r9s0t1'
branch_labels = None
depends_on = None


def column_exists(table_name, column_name):
    bind = op.get_bind()
    return column_name in {c['name'] for c in sa.inspect(bind).get_columns(table_name)}


def index_exists(table_name, index_name):
    bind = op.get_bind()
    return index_name in {i['name'] for i in sa.inspect(bind).get_indexes(table_name)}


def upgrade():
    # Discord snowflake for accounts created through "Login with Discord". Unique so
    # one Discord account can never map to two Fireshare users.
    with op.batch_alter_table('user', schema=None) as batch_op:
        if not column_exists('user', 'discord_id'):
            batch_op.add_column(sa.Column('discord_id', sa.String(length=32), nullable=True))
    if not index_exists('user', 'ix_user_discord_id'):
        with op.batch_alter_table('user', schema=None) as batch_op:
            batch_op.create_index('ix_user_discord_id', ['discord_id'], unique=True)


def downgrade():
    if index_exists('user', 'ix_user_discord_id'):
        with op.batch_alter_table('user', schema=None) as batch_op:
            batch_op.drop_index('ix_user_discord_id')
    if column_exists('user', 'discord_id'):
        with op.batch_alter_table('user', schema=None) as batch_op:
            batch_op.drop_column('discord_id')
